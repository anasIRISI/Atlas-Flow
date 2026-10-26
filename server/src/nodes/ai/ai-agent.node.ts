// AI Agent: asks the attached Chat Model, runs the tools it calls, and answers when the model answers with text.
// Contract: docs/phase6-contracts.md (function calling fields: https://ai.google.dev/api/generate-content)
import type { JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode, type AiTool, type LlmMessage, type LlmToolCall } from '../../engine/types.js';

const MAX_ITERATIONS = 8;
const DEFAULT_TOOL_TIMEOUT_S = 30;
/** A tool result longer than this (as JSON) is cut before it goes back to the model. */
const MAX_RESULT_CHARS = 20_000;

const num = (value: unknown, fallback: number): number => (value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? fallback : Number(value));

/** Anything JSON-serializable → something safe to send to the model, cut when too long. */
function limitResult(output: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(output) ?? 'null';
  } catch {
    return '[the tool returned a value that cannot be converted to JSON]';
  }
  if (json.length <= MAX_RESULT_CHARS) return output === undefined ? null : output;
  return `${json.slice(0, MAX_RESULT_CHARS)}… [result cut: it had ${json.length} characters, only the first ${MAX_RESULT_CHARS} are shown]`;
}

/** Runs one tool call. Never throws except when the whole execution is aborted. */
async function runTool(tools: Map<string, AiTool>, call: LlmToolCall, timeoutS: number, signal: AbortSignal): Promise<{ output: unknown; isError: boolean }> {
  const tool = tools.get(call.name);
  if (!tool) return { isError: true, output: `Unknown tool "${call.name}". Available tools: ${[...tools.keys()].join(', ') || 'none'}` };

  const controller = new AbortController();
  const abortOnExecution = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abortOnExecution, { once: true });
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`The tool "${call.name}" took more than ${timeoutS} s and was stopped`));
      controller.abort(new Error('tool timeout'));
    }, timeoutS * 1000);
  });
  try {
    const output = await Promise.race([tool.invoke(call.args, { signal: controller.signal }), timeout]);
    return { isError: false, output: limitResult(output) };
  } catch (err) {
    if (signal.aborted) throw signal.reason ?? err;
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, output: timedOut ? `The tool "${call.name}" took more than ${timeoutS} s and was stopped` : message || 'The tool failed' };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abortOnExecution);
    // A tool that ignored the abort and fails later must not become an unhandled rejection.
    timeout.catch(() => undefined);
  }
}

export default defineNode({
  description: {
    type: 'flowforge.aiAgent',
    displayName: 'AI Agent',
    description: 'An assistant that decides which tools to use to answer. Attach a Chat Model, optional Memory and Tools.',
    icon: 'lucide:bot',
    group: 'ai',
    version: 1,
    defaults: { name: 'AI Agent', color: '#7c3aed' },
    inputs: [
      { type: 'main' },
      { type: 'ai_languageModel', displayName: 'Chat Model', required: true, maxConnections: 1 },
      { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 },
      { type: 'ai_tool', displayName: 'Tool' },
    ],
    outputs: [{ type: 'main' }],
    keywords: ['agent', 'ai', 'llm', 'assistant', 'tools', 'gemini', 'chat', 'function calling'],
  },
  properties: [
    { name: 'prompt', displayName: 'Prompt (User Message)', type: 'string', default: '={{ $json.chatInput }}', required: true, typeOptions: { rows: 4 }, description: 'What the user asks. The Chat Trigger puts it in chatInput.' },
    {
      name: 'systemMessage',
      displayName: 'System Message',
      type: 'string',
      default: 'You are a helpful assistant.',
      typeOptions: { rows: 4 },
      description: 'How the agent should behave: role, tone, rules for using its tools.',
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'maxIterations', displayName: 'Max Iterations', type: 'number', default: 8, typeOptions: { minValue: 1, maxValue: 8 }, description: 'Most model calls for one message (1 to 8). The last one must answer without tools.' },
        { name: 'toolTimeout', displayName: 'Tool Timeout (Seconds)', type: 'number', default: DEFAULT_TOOL_TIMEOUT_S, typeOptions: { minValue: 1, maxValue: 600 }, description: 'A tool that takes longer is stopped and the model is told.' },
      ],
    },
  ],
  async execute(ctx) {
    const out = await ctx.forEachItem(async (_item, i) => {
      const model = await ctx.getAiChatModel(i);
      if (!model) {
        throw new NodeOperationError('No Chat Model is connected to the AI Agent', {
          itemIndex: i,
          hint: 'Attach a Gemini Chat Model to the "Chat Model" slot under the agent.',
        });
      }
      const prompt = String(ctx.getNodeParameter('prompt', i, '') ?? '');
      if (!prompt.trim()) {
        throw new NodeOperationError('The prompt of the AI Agent is empty', {
          itemIndex: i,
          hint: 'Write the question, or use an expression such as {{ $json.chatInput }} (the Chat Trigger puts the message there).',
        });
      }
      const options = ctx.getNodeParameter<JsonObject>('options', i, {});
      const maxIterations = Math.min(Math.max(Math.floor(num(options.maxIterations, MAX_ITERATIONS)), 1), MAX_ITERATIONS);
      const toolTimeout = Math.min(Math.max(num(options.toolTimeout, DEFAULT_TOOL_TIMEOUT_S), 0.05), 600);
      const system = String(ctx.getNodeParameter('systemMessage', i, '') ?? '').trim() || undefined;

      const memory = await ctx.getAiMemory(i);
      const toolList = await ctx.getAiTools(i);
      const tools = new Map<string, AiTool>();
      for (const tool of toolList) {
        if (tools.has(tool.name)) {
          throw new NodeOperationError(`Two tools are named "${tool.name}"`, { itemIndex: i, hint: 'Give each tool a different name: the model chooses a tool by its name.' });
        }
        tools.set(tool.name, tool);
      }
      const declared = toolList.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));

      const messages: LlmMessage[] = [];
      for (const turn of memory?.load() ?? []) {
        if (turn.text.trim()) messages.push(turn.role === 'user' ? { role: 'user', text: turn.text } : { role: 'model', text: turn.text });
      }
      messages.push({ role: 'user', text: prompt });

      const log: JsonObject[] = [];
      const usage = { promptTokens: 0, outputTokens: 0, totalTokens: 0 };
      let answer: string | undefined;
      let iterations = 0;
      let modelName = model.model;

      while (iterations < maxIterations) {
        iterations++;
        const last = iterations === maxIterations;
        const turn = await model.generate({ system, messages, tools: declared.length ? declared : undefined, toolChoice: last ? 'none' : 'auto' }, { signal: ctx.signal });
        usage.promptTokens += turn.usage.promptTokens;
        usage.outputTokens += turn.usage.outputTokens;
        usage.totalTokens += turn.usage.totalTokens;
        modelName = turn.model || modelName;

        if (!turn.toolCalls.length || last) {
          // On the last allowed call tools are switched off: tool calls it still makes are not run.
          if (turn.text.trim()) answer = turn.text;
          break;
        }
        messages.push({ role: 'model', text: turn.text, toolCalls: turn.toolCalls, raw: turn.raw });
        const results: Extract<LlmMessage, { role: 'tool' }>['results'] = [];
        for (const call of turn.toolCalls) {
          const result = await runTool(tools, call, toolTimeout, ctx.signal);
          results.push({ ...(call.id ? { id: call.id } : {}), name: call.name, output: result.output, isError: result.isError });
          log.push({ tool: call.name, input: call.args, ...(result.isError ? { error: String(result.output) } : { output: result.output as JsonObject }) });
        }
        messages.push({ role: 'tool', results });
      }

      if (answer === undefined) {
        throw new NodeOperationError(`The agent did not reach an answer in ${maxIterations} steps`, {
          itemIndex: i,
          hint: 'The model kept calling tools. Raise "Max Iterations" (at most 8), make the System Message more precise about when to stop, or simplify the tools.',
        });
      }

      memory?.save([
        { role: 'user', text: prompt },
        { role: 'model', text: answer },
      ]);
      return {
        json: {
          output: answer,
          iterations,
          toolCalls: log,
          model: modelName,
          usage,
          stoppedAtLimit: iterations === maxIterations && log.length > 0,
        },
      };
    });
    return [out];
  },
});
