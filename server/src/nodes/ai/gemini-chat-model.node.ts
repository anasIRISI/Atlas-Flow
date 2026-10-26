// Docs: https://ai.google.dev/api/generate-content (function calling; client: server/src/integrations/gemini.ts)
// Chat Model sub-node of the AI Agent: turns the provider-neutral LlmRequest into Gemini `contents` and back.
import type { JsonObject } from '@flowforge/shared';
import { FlowError, NodeOperationError } from '../../engine/errors.js';
import { defineNode, type AiChatModel, type ExecuteContext, type LlmMessage, type LlmRequest, type LlmToolCall } from '../../engine/types.js';
import { GEMINI_DEFAULT_MODEL, GEMINI_MODELS, generateTurn } from '../../integrations/gemini.js';
import { toNodeError } from '../../integrations/errors.js';

const CREDENTIAL = 'googlePalmApi';

function resolveModel(ctx: ExecuteContext, itemIndex: number, credentialModel: unknown): string {
  const choice = String(ctx.getNodeParameter('model', itemIndex, 'default'));
  if (choice === 'custom') {
    const custom = String(ctx.getNodeParameter('customModel', itemIndex, '')).trim();
    if (!custom) throw new NodeOperationError('The custom model name is empty', { itemIndex, hint: `Enter a model id such as ${GEMINI_DEFAULT_MODEL}, or choose a model from the list.` });
    return custom;
  }
  if (choice !== 'default') return choice;
  return String(credentialModel ?? '').trim() || GEMINI_DEFAULT_MODEL;
}

const optionalNumber = (value: unknown): number | undefined => (value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value));
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A tool result is sent as a JSON object: other values are wrapped as `{ result }`, a failed call is `{ error }`. */
function toolResponse(output: unknown, isError: boolean | undefined): Record<string, unknown> {
  if (isError) return { error: typeof output === 'string' ? output : JSON.stringify(output) };
  if (isPlainObject(output)) return output;
  return { result: output === undefined ? null : output };
}

const callPart = (call: LlmToolCall) => ({ functionCall: { ...(call.id ? { id: call.id } : {}), name: call.name, args: call.args } });

/** LlmMessage[] → Gemini `contents`. A model message with `raw` is sent back untouched (thought signatures live in it). */
export function toGeminiContents(messages: LlmMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === 'user') return { role: 'user', parts: [{ text: message.text }] };
    if (message.role === 'model') {
      if (message.raw !== undefined) return message.raw;
      const parts: unknown[] = [];
      if (message.text) parts.push({ text: message.text });
      for (const call of message.toolCalls ?? []) parts.push(callPart(call));
      return { role: 'model', parts };
    }
    return {
      role: 'user',
      parts: message.results.map((r) => ({ functionResponse: { ...(r.id ? { id: r.id } : {}), name: r.name, response: toolResponse(r.output, r.isError) } })),
    };
  });
}

export default defineNode({
  description: {
    type: 'flowforge.geminiChatModel',
    displayName: 'Gemini Chat Model',
    description: 'The Google Gemini model an AI Agent thinks with (function calling).',
    icon: 'lucide:sparkles',
    group: 'ai-sub',
    version: 1,
    defaults: { name: 'Gemini Chat Model', color: '#8b5cf6' },
    subtitle: '{{model}}',
    inputs: [],
    outputs: [{ type: 'ai_languageModel', displayName: 'Model' }],
    credentials: [{ type: CREDENTIAL, required: true }],
    keywords: ['gemini', 'google', 'ai', 'llm', 'chat', 'model', 'agent'],
  },
  properties: [
    {
      name: 'model',
      displayName: 'Model',
      type: 'options',
      default: 'default',
      options: [
        { name: 'Default (credential / GEMINI_MODEL)', value: 'default', description: 'The model of the credential, else GEMINI_MODEL in .env, else gemini-3.8-flash' },
        ...GEMINI_MODELS.map((id) => ({ name: id, value: id })),
        { name: 'Custom…', value: 'custom', description: 'Any model id' },
      ],
    },
    { name: 'customModel', displayName: 'Custom Model', type: 'string', default: '', placeholder: GEMINI_DEFAULT_MODEL, displayOptions: { show: { model: ['custom'] } } },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'temperature', displayName: 'Temperature', type: 'number', default: 1, typeOptions: { minValue: 0, maxValue: 2 }, description: '0 = precise, 2 = creative.' },
        { name: 'maxOutputTokens', displayName: 'Max Output Tokens', type: 'number', default: 2048, typeOptions: { minValue: 1 }, description: 'Thinking tokens count too: do not set it too low.' },
        { name: 'topP', displayName: 'Top P', type: 'number', default: 0.95, typeOptions: { minValue: 0, maxValue: 1 } },
        { name: 'topK', displayName: 'Top K', type: 'number', default: 40, typeOptions: { minValue: 1 } },
        { name: 'maxRetries', displayName: 'Max Retries', type: 'number', default: 2, typeOptions: { minValue: 0, maxValue: 5 }, description: 'Retries when Gemini is busy (429 with a short wait, 500, 503).' },
        { name: 'timeout', displayName: 'Timeout (Seconds)', type: 'number', default: 60, typeOptions: { minValue: 1, maxValue: 600 }, description: 'Per model call.' },
      ],
    },
  ],
  async supplyData(ctx, itemIndex): Promise<AiChatModel> {
    const credential = await ctx.getCredentials(CREDENTIAL);
    const apiKey = String(credential.data.apiKey ?? '').trim();
    const host = String(credential.data.host ?? '').trim() || undefined;
    const model = resolveModel(ctx, itemIndex, credential.data.model);
    const options = ctx.getNodeParameter<JsonObject>('options', itemIndex, {});
    const timeoutMs = Math.min(Math.max(optionalNumber(options.timeout) ?? 60, 1), 600) * 1000;

    return {
      provider: 'gemini',
      model,
      async generate(request: LlmRequest, o) {
        try {
          const turn = await generateTurn(
            { apiKey, host },
            {
              model,
              contents: toGeminiContents(request.messages),
              systemInstruction: request.system,
              tools: request.tools?.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters as unknown as Record<string, unknown> })),
              toolChoice: request.toolChoice,
              temperature: optionalNumber(options.temperature),
              maxOutputTokens: optionalNumber(options.maxOutputTokens),
              topP: optionalNumber(options.topP),
              topK: optionalNumber(options.topK),
              maxRetries: optionalNumber(options.maxRetries) ?? 2,
            },
            { signal: o.signal, timeoutMs },
          );
          return {
            text: turn.text,
            toolCalls: turn.functionCalls.map((c) => ({ ...(c.id ? { id: c.id } : {}), name: c.name, args: c.args as JsonObject })),
            finishReason: turn.finishReason,
            model: turn.model,
            usage: { promptTokens: turn.usage.promptTokens, outputTokens: turn.usage.outputTokens, totalTokens: turn.usage.totalTokens },
            raw: turn.content,
          };
        } catch (err) {
          const error = toNodeError(err, { credentialType: CREDENTIAL, credential, envVars: 'GEMINI_API_KEY', docsAnchor: '#google-gemini', itemIndex });
          // The failure belongs to this sub-node, not to the agent that called it.
          if (error instanceof FlowError) error.node ??= ctx.node.name;
          throw error;
        }
      },
    };
  },
});
