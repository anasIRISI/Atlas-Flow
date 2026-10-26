import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CredentialSummary, ExecutionDetail, JsonObject } from '@flowforge/shared';
import { defineNode } from '../src/engine/types.js';
import { IntegrationError } from '../src/integrations/errors.js';
import { generateTurn, retryTiming } from '../src/integrations/gemini.js';
import { answer, apiError, functionCallReply, startGeminiMock, type GeminiMock, type MockFunctionCall } from './gemini-mock.js';
import { getTestRegistry } from './engine-helpers.js';
import { capturingLogger, makeTestApp, type TestApp } from './helpers.js';
import { activate, chain, createWorkflow, node, signedIn, type Agent } from './trigger-helpers.js';

const KEY = 'AIzaSyAgentKey_0123456789abcdefghij';
const TYPE = 'googlePalmApi';

let mock: GeminiMock;
let t: TestApp;
let agent: Agent;
let logger: ReturnType<typeof capturingLogger>;
let credential: CredentialSummary | undefined;

beforeAll(async () => {
  retryTiming.serverErrorBaseMs = 10;
  // A scripted tool stands in for the real tool nodes.
  const registry = await getTestRegistry();
  if (!registry.get('test.scriptedTool')) {
    registry.register(
      defineNode({
        description: {
          hidden: true,
          version: 1,
          icon: 'lucide:flask-conical',
          type: 'test.scriptedTool',
          displayName: 'Scripted Tool',
          description: 'Weather tool stand-in',
          group: 'ai-sub',
          defaults: { name: 'Scripted Tool' },
          inputs: [],
          outputs: [{ type: 'ai_tool' }],
        },
        properties: [
          { name: 'toolName', displayName: 'Name', type: 'string', default: 'get_weather' },
          { name: 'mode', displayName: 'Mode', type: 'string', default: 'ok' },
        ],
        supplyData(ctx, i) {
          const mode = ctx.getNodeParameter<string>('mode', i, 'ok');
          return {
            name: ctx.getNodeParameter<string>('toolName', i, 'get_weather'),
            description: 'Current weather of a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
            async invoke(args, o) {
              if (mode === 'throw') throw new Error('weather service exploded');
              if (mode === 'slow') {
                await new Promise((resolve, reject) => {
                  const timer = setTimeout(resolve, 5000);
                  o.signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new Error('aborted'));
                  });
                });
              }
              if (mode === 'big') return 'x'.repeat(30_000);
              return { city: args.city, temperatureC: 21, sky: 'sunny' };
            },
          };
        },
      }),
    );
  }
});
beforeEach(async () => {
  mock = await startGeminiMock();
  logger = capturingLogger();
  credential = undefined;
});
afterEach(async () => {
  await t?.close();
  await mock.close();
});

async function start() {
  t = await makeTestApp({}, { logger });
  agent = await signedIn(t);
}

async function saveCredential() {
  const res = await agent.post('/api/credentials').send({ name: 'Gemini', type: TYPE, data: { apiKey: KEY, host: mock.url } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  credential = res.body as CredentialSummary;
  return credential;
}

interface RunSummary {
  executionId: string;
  status: string;
  error?: { message: string; hint?: string; node?: string; credentialType?: string; credentialId?: string; envVar?: string };
  output: JsonObject[][];
}

interface AgentRun {
  summary: RunSummary;
  detail: ExecutionDetail;
  /** Output of the agent (first item). */
  out: JsonObject;
}

interface Setup {
  /** Sub-nodes: [name, type, parameters]. Default: one scripted weather tool. */
  tools?: [string, string, JsonObject?][];
  memory?: boolean;
  noModel?: boolean;
  prompt?: string;
  agent?: JsonObject;
  model?: JsonObject;
  /** Items of the input node (default: one chat message). */
  items?: JsonObject[];
}

function build(o: Setup) {
  const items = o.items ?? [{ chatInput: 'What is the weather in Paris?', sessionId: 'session-a' }];
  const nodes = [
    node('Start', 'manualTrigger'),
    node('Input', 'code', { jsCode: `return ${JSON.stringify(items)}.map((json) => ({ json }));` }),
    node('Agent', 'aiAgent', { ...(o.prompt !== undefined ? { prompt: o.prompt } : {}), ...(o.agent ?? {}) }),
  ];
  const connections = chain('Start', 'Input', 'Agent');
  const sub = (name: string, type: string, parameters: JsonObject, slot: 'ai_languageModel' | 'ai_memory' | 'ai_tool') => {
    nodes.push(node(name, type, parameters));
    connections[name] = { [slot]: [[{ node: 'Agent', type: slot, index: 0 }]] };
  };
  if (!o.noModel) sub('Model', 'geminiChatModel', { options: { maxRetries: 0 }, ...(o.model ?? {}) }, 'ai_languageModel');
  if (o.memory) sub('Memory', 'simpleMemory', {}, 'ai_memory');
  for (const [name, type, parameters] of o.tools ?? [['Weather', 'test.scriptedTool', {}]]) sub(name, type, parameters ?? {}, 'ai_tool');
  return { name: 'Agent test', nodes, connections };
}

async function ask(o: Setup = {}): Promise<AgentRun> {
  const res = await agent.post('/api/dev/run').send(build(o));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const summary = res.body as RunSummary;
  const detailRes = await agent.get(`/api/executions/${summary.executionId}`);
  const detail = detailRes.body as ExecutionDetail;
  return { summary, detail, out: (detail.runData.Agent?.[0]?.data.main[0]?.[0]?.json ?? {}) as JsonObject };
}

const contents = (call: { body?: any }) => call.body.contents as { role: string; parts: any[] }[];
const texts = (call: { body?: any }) => contents(call).map((c) => `${c.role}: ${c.parts[0].text ?? '(parts)'}`);
const responses = (call: { body?: any }) => contents(call).at(-1)!.parts.map((p) => p.functionResponse);
const jsonOf = (run: AgentRun, name: string, index = 0) => run.detail.runData[name]![index]!.data.main[0]![0]!.json;

describe('AI Agent: answers and tools', () => {
  it('answers a plain question with one model call and sends the system message as systemInstruction', async () => {
    await start();
    await saveCredential();
    mock.enqueue(answer('Hello there!', { modelVersion: 'gemini-3.8-flash' }));
    const run = await ask({ tools: [], prompt: 'Say hello', agent: { systemMessage: 'You are a pirate.' } });
    expect(run.summary.status, JSON.stringify(run.summary.error)).toBe('success');
    expect(run.out).toMatchObject({ output: 'Hello there!', iterations: 1, toolCalls: [], model: 'gemini-3.8-flash', stoppedAtLimit: false, usage: { promptTokens: 7, outputTokens: 3, totalTokens: 10 } });
    expect(mock.calls).toHaveLength(1);
    const body = mock.calls[0]!.body;
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are a pirate.' }] });
    expect(body.tools).toBeUndefined();
    expect(body.toolConfig).toBeUndefined();
    expect(contents(mock.calls[0]!)).toEqual([{ role: 'user', parts: [{ text: 'Say hello' }] }]);
    expect(mock.calls[0]!.headers['x-goog-api-key']).toBe(KEY);
  });

  it('answers a weather question through a tool and resends the model content unchanged (thought signatures)', async () => {
    await start();
    await saveCredential();
    const first = functionCallReply([{ name: 'get_weather', args: { city: 'Paris' }, id: 'call-1' }]);
    mock.enqueue(first, answer('It is sunny in Paris, 21 degrees.'));
    const run = await ask({ memory: true });
    expect(run.summary.status, JSON.stringify(run.summary.error)).toBe('success');
    expect(run.out.output).toBe('It is sunny in Paris, 21 degrees.');
    expect(run.out).toMatchObject({
      iterations: 2,
      stoppedAtLimit: false,
      toolCalls: [{ tool: 'get_weather', input: { city: 'Paris' }, output: { city: 'Paris', temperatureC: 21, sky: 'sunny' } }],
      usage: { promptTokens: 27, outputTokens: 7, totalTokens: 34 },
    });
    expect(mock.calls).toHaveLength(2);

    // First request: tool declared in the documented shape, default mode (no toolConfig).
    expect(mock.calls[0]!.body.tools).toEqual([
      {
        functionDeclarations: [
          { name: 'get_weather', description: 'Current weather of a city', parametersJsonSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
        ],
      },
    ]);
    expect(mock.calls[0]!.body.toolConfig).toBeUndefined();

    // Second request: [user, the model content EXACTLY as sent, functionResponse].
    const sent = contents(mock.calls[1]!);
    expect(sent).toHaveLength(3);
    expect(sent[0]).toEqual({ role: 'user', parts: [{ text: 'What is the weather in Paris?' }] });
    expect(sent[1]).toStrictEqual(first.content);
    expect(JSON.stringify(sent[1])).toBe(JSON.stringify(first.content));
    expect(sent[1]!.parts.map((p) => p.thoughtSignature)).toEqual(['c2lnLXRob3VnaHQ=', 'c2lnLWNhbGwtMQ==']);
    expect(sent[2]).toEqual({ role: 'user', parts: [{ functionResponse: { id: 'call-1', name: 'get_weather', response: { city: 'Paris', temperatureC: 21, sky: 'sunny' } } }] });

    // The sub-nodes are recorded: 2 model calls, 1 memory load + 1 save, 1 tool call.
    expect(run.detail.runData.Model).toHaveLength(2);
    expect(run.detail.runData.Weather).toHaveLength(1);
    expect(jsonOf(run, 'Weather')).toMatchObject({ tool: 'get_weather', input: { city: 'Paris' } });
    expect(run.detail.runData.Memory!.map((r) => r.data.main[0]![0]!.json.action)).toEqual(['load', 'save']);
    expect(jsonOf(run, 'Model', 0)).toMatchObject({ response: { toolCalls: [{ name: 'get_weather' }] }, tools: ['get_weather'] });
  });

  it('runs two parallel calls in order and answers with one tool message', async () => {
    await start();
    await saveCredential();
    mock.enqueue(functionCallReply([{ name: 'get_weather', args: { city: 'Paris' } }, { name: 'get_weather', args: { city: 'Rome' } }]), answer('Both are sunny.'));
    const run = await ask();
    expect(run.out).toMatchObject({ output: 'Both are sunny.', iterations: 2 });
    expect((run.out.toolCalls as JsonObject[]).map((c) => (c.input as JsonObject).city)).toEqual(['Paris', 'Rome']);
    const sent = responses(mock.calls[1]!);
    expect(sent.map((r) => r.name)).toEqual(['get_weather', 'get_weather']);
    expect(sent.map((r) => r.response.city)).toEqual(['Paris', 'Rome']);
    // No id in the call ⇒ none in the response.
    expect(sent[0]).not.toHaveProperty('id');
    expect(run.detail.runData.Weather).toHaveLength(2);
  });

  it('gives an unknown tool back to the model as an error result', async () => {
    await start();
    await saveCredential();
    mock.enqueue(functionCallReply([{ name: 'launch_rocket', args: {} }]), answer('Sorry, I cannot do that.'));
    const run = await ask();
    expect(run.summary.status).toBe('success');
    expect(run.out.output).toBe('Sorry, I cannot do that.');
    expect(responses(mock.calls[1]!)).toEqual([{ name: 'launch_rocket', response: { error: 'Unknown tool "launch_rocket". Available tools: get_weather' } }]);
    expect(run.out.toolCalls).toEqual([{ tool: 'launch_rocket', input: {}, error: 'Unknown tool "launch_rocket". Available tools: get_weather' }]);
  });

  it('gives a failing tool back to the model as { error } and still answers', async () => {
    await start();
    await saveCredential();
    mock.enqueue(functionCallReply([{ name: 'get_weather', args: { city: 'Paris' }, id: 'c1' }]), answer('The weather service is down.'));
    const run = await ask({ tools: [['Weather', 'test.scriptedTool', { mode: 'throw' }]] });
    expect(run.summary.status, JSON.stringify(run.summary.error)).toBe('success');
    expect(run.out.output).toBe('The weather service is down.');
    expect(responses(mock.calls[1]!)).toEqual([{ id: 'c1', name: 'get_weather', response: { error: 'weather service exploded' } }]);
    expect(run.detail.runData.Weather![0]).toMatchObject({ status: 'error' });
  });

  it('stops a tool that takes too long, tells the model, and still answers', async () => {
    await start();
    await saveCredential();
    mock.enqueue(functionCallReply([{ name: 'get_weather', args: { city: 'Paris' } }]), answer('No weather data, sorry.'));
    const started = Date.now();
    const run = await ask({ tools: [['Weather', 'test.scriptedTool', { mode: 'slow' }]], agent: { options: { toolTimeout: 0.1 } } });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(run.summary.status, JSON.stringify(run.summary.error)).toBe('success');
    expect(run.out.output).toBe('No weather data, sorry.');
    const error = responses(mock.calls[1]!)[0].response.error as string;
    expect(error).toMatch(/get_weather/);
    expect(error).toMatch(/took more than 0\.1 s/);
  });

  it('cuts a huge tool result before it goes back to the model', async () => {
    await start();
    await saveCredential();
    mock.enqueue(functionCallReply([{ name: 'get_weather', args: { city: 'Paris' } }]), answer('ok'));
    await ask({ tools: [['Weather', 'test.scriptedTool', { mode: 'big' }]] });
    const result = responses(mock.calls[1]!)[0].response.result as string;
    expect(result.length).toBeLessThan(20_500);
    expect(result).toContain('result cut');
  });

  it('refuses two tools with the same name', async () => {
    await start();
    await saveCredential();
    const run = await ask({
      tools: [
        ['Weather', 'test.scriptedTool', {}],
        ['Weather 2', 'test.scriptedTool', {}],
      ],
    });
    expect(run.summary.status).toBe('error');
    expect(run.summary.error?.message).toBe('Two tools are named "get_weather"');
    expect(mock.calls).toHaveLength(0);
  });
});

describe('AI Agent: the loop is bounded', () => {
  const always = (n: number): MockFunctionCall[] => Array.from({ length: n }, () => ({ name: 'get_weather', args: { city: 'Paris' } }));

  it('makes exactly maxIterations model calls, the last one without tools, then fails clearly and saves nothing', async () => {
    await start();
    await saveCredential();
    // The mock keeps asking for tools, even when told not to.
    mock.enqueue(...always(10).map((c) => functionCallReply([c])));
    const run = await ask({ memory: true, agent: { options: { maxIterations: 3 } } });
    expect(mock.calls).toHaveLength(3);
    expect(mock.calls[0]!.body.toolConfig).toBeUndefined();
    expect(mock.calls[1]!.body.toolConfig).toBeUndefined();
    expect(mock.calls[2]!.body.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    expect(mock.calls[2]!.body.tools).toBeDefined();
    expect(run.summary.status).toBe('error');
    expect(run.summary.error).toMatchObject({ message: 'The agent did not reach an answer in 3 steps', node: 'Agent' });
    expect(run.summary.error?.hint).toMatch(/Max Iterations/);
    // The tool ran for the two allowed rounds only: the tool calls of the last (tool-less) call are not run.
    expect(run.detail.runData.Weather).toHaveLength(2);
    expect(t.ctx.chatMemory.count('unsaved:session-a')).toBe(0);
    expect(run.detail.runData.Memory!.map((r) => r.data.main[0]![0]?.json.action)).toEqual(['load']);
  });

  it('caps maxIterations at 8, whatever the setting', async () => {
    await start();
    await saveCredential();
    mock.enqueue(...always(30).map((c) => functionCallReply([c])));
    const run = await ask({ agent: { options: { maxIterations: 50 } } });
    expect(mock.calls).toHaveLength(8);
    expect(mock.calls[7]!.body.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    expect(run.summary.error?.message).toBe('The agent did not reach an answer in 8 steps');
  });

  it('still answers when the model answers on the last allowed call', async () => {
    await start();
    await saveCredential();
    mock.enqueue(functionCallReply([{ name: 'get_weather', args: { city: 'Paris' } }]), answer('Final answer'));
    const run = await ask({ agent: { options: { maxIterations: 2 } } });
    expect(run.summary.status).toBe('success');
    expect(run.out).toMatchObject({ output: 'Final answer', iterations: 2, stoppedAtLimit: true });
    expect(mock.calls[1]!.body.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
  });
});

describe('AI Agent: memory', () => {
  it('keeps the context between two messages of the same session and keeps sessions apart', async () => {
    await start();
    await saveCredential();
    mock.enqueue(answer('Hello Ada!'), answer('Your name is Ada.'), answer('I do not know your name.'));
    await ask({ tools: [], memory: true, items: [{ chatInput: 'My name is Ada', sessionId: 'ada' }] });
    await ask({ tools: [], memory: true, items: [{ chatInput: 'What is my name?', sessionId: 'ada' }] });
    const other = await ask({ tools: [], memory: true, items: [{ chatInput: 'What is my name?', sessionId: 'bob' }] });
    expect(texts(mock.calls[0]!)).toEqual(['user: My name is Ada']);
    expect(texts(mock.calls[1]!)).toEqual(['user: My name is Ada', 'model: Hello Ada!', 'user: What is my name?']);
    expect(texts(mock.calls[2]!)).toEqual(['user: What is my name?']);
    expect(other.out.output).toBe('I do not know your name.');
    expect(t.ctx.chatMemory.count('unsaved:ada')).toBe(4);
    expect(t.ctx.chatMemory.count('unsaved:bob')).toBe(2);
  });

  it('saves only the question and the final answer, not the tool steps', async () => {
    await start();
    await saveCredential();
    mock.enqueue(functionCallReply([{ name: 'get_weather', args: { city: 'Paris' } }]), answer('Sunny.'));
    await ask({ memory: true });
    expect(t.ctx.chatMemory.load('unsaved:session-a', 10)).toEqual([
      { role: 'user', text: 'What is the weather in Paris?' },
      { role: 'model', text: 'Sunny.' },
    ]);
  });

  it('saves nothing when the model fails', async () => {
    await start();
    await saveCredential();
    mock.enqueue(apiError(400, 'Bad request for the test'));
    const run = await ask({ tools: [], memory: true });
    expect(run.summary.status).toBe('error');
    expect(t.ctx.chatMemory.count('unsaved:session-a')).toBe(0);
  });

  it('reports an empty session id on the memory sub-node', async () => {
    await start();
    await saveCredential();
    const run = await ask({ tools: [], memory: true, items: [{ chatInput: 'Hi', sessionId: '' }] });
    expect(run.summary.status).toBe('error');
    expect(run.summary.error).toMatchObject({ message: 'The chat session id is empty', node: 'Memory' });
    expect(mock.calls).toHaveLength(0);
  });
});

describe('AI Agent: errors', () => {
  it('says which slot is empty when no chat model is attached', async () => {
    await start();
    await saveCredential();
    const run = await ask({ noModel: true });
    expect(run.summary.status).toBe('error');
    expect(run.summary.error).toMatchObject({ message: 'No Chat Model is connected to the AI Agent', node: 'Agent' });
    expect(run.summary.error?.hint).toMatch(/Chat Model/);
    expect(mock.calls).toHaveLength(0);
  });

  it('refuses an empty prompt', async () => {
    await start();
    await saveCredential();
    const run = await ask({ prompt: '={{ $json.nothing }}' });
    expect(run.summary.status).toBe('error');
    expect(run.summary.error).toMatchObject({ message: 'The prompt of the AI Agent is empty', node: 'Agent' });
    expect(mock.calls).toHaveLength(0);
  });

  it('a missing Gemini credential is an error of the Chat Model sub-node, with the .env variable', async () => {
    await start();
    const run = await ask();
    expect(run.summary.status).toBe('error');
    expect(run.summary.error).toMatchObject({ credentialType: TYPE, envVar: 'GEMINI_API_KEY', node: 'Model' });
    expect(run.detail.runData.Model![0]).toMatchObject({ status: 'error', error: { credentialType: TYPE, envVar: 'GEMINI_API_KEY' } });
    expect(mock.calls).toHaveLength(0);
  });

  it('a wrong key is a CredentialError pointing at the saved credential, on the Chat Model sub-node', async () => {
    await start();
    const saved = await saveCredential();
    mock.enqueue(apiError(400, 'API key not valid. Please pass a valid API key.', [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }], 'INVALID_ARGUMENT'));
    const run = await ask();
    expect(run.summary.status).toBe('error');
    expect(run.summary.error).toMatchObject({ message: 'The Gemini API key is not valid', credentialType: TYPE, credentialId: saved.id, node: 'Model' });
    expect(run.detail.runData.Model![0]).toMatchObject({ status: 'error' });
    expect(mock.calls).toHaveLength(1);
  });

  it('retries a 429 with a short wait, then succeeds', async () => {
    await start();
    await saveCredential();
    mock.enqueue(apiError(429, 'Quota exceeded', [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.05s' }], 'RESOURCE_EXHAUSTED'), answer('Finally'));
    const run = await ask({ tools: [], model: { options: { maxRetries: 2 } } });
    expect(run.summary.status, JSON.stringify(run.summary.error)).toBe('success');
    expect(run.out.output).toBe('Finally');
    expect(mock.calls).toHaveLength(2);
  });

  it('a model call that takes too long is a clear error on the Chat Model', async () => {
    await start();
    await saveCredential();
    mock.enqueue({ ...answer('too late'), delayMs: 3000 });
    const run = await ask({ tools: [], model: { options: { maxRetries: 0, timeout: 1 } } });
    expect(run.summary.status).toBe('error');
    expect(run.summary.error?.message).toMatch(/^No answer from .* within 1 s$/);
    expect(run.summary.error?.node).toBe('Model');
  });

  it('a tool-call failure from Gemini without text is a clear error', async () => {
    await start();
    await saveCredential();
    mock.enqueue({ body: { candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] } });
    const run = await ask();
    expect(run.summary.status).toBe('error');
    expect(run.summary.error?.message).toBe('Gemini could not call the tool (MALFORMED_FUNCTION_CALL)');
  });
});

describe('AI Agent: secrets and the Chat Trigger', () => {
  it('never puts the API key in the run result, the sub-node run data or the logs', async () => {
    await start();
    await saveCredential();
    mock.enqueue(functionCallReply([{ name: 'get_weather', args: { city: 'Paris' } }]), answer('Sunny.'), apiError(400, `API key not valid: ${KEY}`, [], 'INVALID_ARGUMENT'));
    const good = await ask({ memory: true });
    const bad = await ask({ tools: [] });
    expect(good.summary.status).toBe('success');
    expect(bad.summary.status).toBe('error');
    for (const run of [good, bad]) {
      expect(JSON.stringify(run.summary)).not.toContain(KEY);
      expect(JSON.stringify(run.detail)).not.toContain(KEY);
    }
    expect(JSON.stringify((await agent.get('/api/credentials')).body)).not.toContain(KEY);
    expect(logger.lines.join('\n')).not.toContain(KEY);
  });

  it('answers a Chat Trigger message with the output field and remembers the session', async () => {
    await start();
    await saveCredential();
    const body = build({ tools: [], memory: true });
    const nodes = [node('Chat', 'chatTrigger', { options: { path: 'agent-bot' } }), ...body.nodes.filter((n) => !['Start', 'Input'].includes(n.name))];
    const connections = { ...body.connections, ...chain('Chat', 'Agent') };
    delete (connections as Record<string, unknown>).Start;
    delete (connections as Record<string, unknown>).Input;
    const id = await createWorkflow(agent, { name: 'Agent chat', nodes, connections });
    expect((await activate(agent, id)).status).toBe(200);
    mock.enqueue(answer('Hello Ada!'), answer('Your name is Ada.'));
    const say = (chatInput: string) => request(t.app).post('/chat/agent-bot').set('Accept', 'application/json').send({ chatInput, sessionId: 'web' });
    const first = await say('My name is Ada');
    expect(first.body).toEqual({ output: 'Hello Ada!', sessionId: 'web' });
    const second = await say('What is my name?');
    expect(second.body.output).toBe('Your name is Ada.');
    expect(texts(mock.calls[1]!)).toEqual(['user: My name is Ada', 'model: Hello Ada!', 'user: What is my name?']);
    expect(t.ctx.chatMemory.count(`${id}:web`)).toBe(4);
  });
});

describe('generateTurn', () => {
  it('returns the raw content, the text and the function calls of a turn', async () => {
    const reply = functionCallReply([{ name: 'a', args: { x: 1 }, id: 'i1' }, { name: 'b' }]);
    mock.enqueue(reply);
    const turn = await generateTurn({ apiKey: KEY, host: mock.url }, { model: 'gemini-3.8-flash', contents: [{ role: 'user', parts: [{ text: 'hi' }] }], maxRetries: 0 });
    expect(turn.content).toStrictEqual(reply.content);
    expect(turn.text).toBe('');
    expect(turn.functionCalls).toEqual([{ id: 'i1', name: 'a', args: { x: 1 } }, { name: 'b', args: {} }]);
    expect(turn.usage.promptTokens).toBe(20);
  });

  it('is an IntegrationError when there is neither text nor a function call', async () => {
    mock.enqueue({ body: { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }] } });
    const error = await generateTurn({ apiKey: KEY, host: mock.url }, { model: 'gemini-3.8-flash', contents: [], maxRetries: 0 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as Error).message).toBe('Gemini returned an empty answer');
  });
});
