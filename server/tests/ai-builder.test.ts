import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BuildWorkflowResponse, CredentialSummary, JsonObject } from '@flowforge/shared';
import { EXAMPLES_DIR } from '../src/api/examples.js';
import { buildWorkflow, nodeOrder, OFFLINE_LABEL, AI_LABEL, type BuilderDeps } from '../src/ai/builder/index.js';
import { buildCatalog, CATALOG_MAX_CHARS } from '../src/ai/builder/catalog.js';
import { loadTemplates, rankTemplates, WEAK_SCORE } from '../src/ai/builder/fallback.js';
import { layoutNodes } from '../src/ai/builder/layout.js';
import { EXAMPLE_ANSWER } from '../src/ai/builder/prompt.js';
import { BUILT_IN_TEMPLATES } from '../src/ai/builder/templates.js';
import { resolveNodeType, validateWorkflow, type ValidateContext } from '../src/ai/builder/validate.js';
import { MissingCredentialError } from '../src/engine/errors.js';
import { defineNode } from '../src/engine/types.js';
import { retryTiming } from '../src/integrations/gemini.js';
import { NodeRegistry } from '../src/nodes/registry.js';
import { answer, apiError, startGeminiMock, type GeminiMock } from './gemini-mock.js';
import { getTestRegistry } from './engine-helpers.js';
import { capturingLogger, makeTestApp, type TestApp } from './helpers.js';
import { signedIn, type Agent } from './trigger-helpers.js';

const KEY = 'AIzaSyBuilderKey_0123456789abcdefghij';
const OTHER_SECRET = 'SECRET-BEARER-TOKEN-9f8e7d6c5b4a';
const TYPE = 'googlePalmApi';

let mock: GeminiMock;
let t: TestApp;
let agent: Agent;
let logger: ReturnType<typeof capturingLogger>;

beforeAll(() => {
  retryTiming.serverErrorBaseMs = 10;
});
beforeEach(async () => {
  mock = await startGeminiMock();
  logger = capturingLogger();
});
afterEach(async () => {
  await t?.close();
  await mock.close();
});

async function start() {
  t = await makeTestApp({}, { logger });
  agent = await signedIn(t);
}

async function saveGemini() {
  const res = await agent.post('/api/credentials').send({ name: 'Gemini', type: TYPE, data: { apiKey: KEY, host: mock.url } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as CredentialSummary;
}

const reply = (value: unknown) => answer(typeof value === 'string' ? value : JSON.stringify(value));

async function build(prompt: string) {
  const res = await agent.post('/api/ai/build-workflow').send({ prompt });
  return { status: res.status, body: res.body as BuildWorkflowResponse };
}

function deps(extra: Partial<BuilderDeps> = {}): BuilderDeps {
  return { registry: t.ctx.registry, credentials: t.ctx.credentials, examplesDir: EXAMPLES_DIR, logger, ...extra };
}

const SIMPLE = {
  name: 'Count',
  nodes: [
    { name: 'Start', type: 'flowforge.manualTrigger', parameters: {} },
    { name: 'Make numbers', type: 'flowforge.code', parameters: { jsCode: 'return [{ json: { n: 1 } }, { json: { n: 2 } }];' } },
    { name: 'Double', type: 'flowforge.set', parameters: { includeOtherFields: true, assignments: { assignments: [{ name: 'double', value: '={{ $json.n * 2 }}', type: 'number' }] } } },
  ],
  connections: [
    { from: 'Start', to: 'Make numbers' },
    { from: 'Make numbers', to: 'Double' },
  ],
  notes: ['Click Execute Workflow to run it.'],
};

type Box = { name: string; x: number; y: number };

/** Everything the contract promises about ANY response, AI or offline. */
function assertRunnable(res: BuildWorkflowResponse, registry: NodeRegistry = t.ctx.registry) {
  const { nodes, connections } = res.workflow;
  const names = nodes.map((n) => n.name);
  expect(new Set(names).size).toBe(names.length);
  expect(nodes.length).toBeGreaterThan(0);
  for (const n of nodes) {
    expect(registry.get(n.type), `unknown node type ${n.type}`).toBeDefined();
    expect(n.id).toBeTruthy();
    expect(Number.isInteger(n.position[0]) && Number.isInteger(n.position[1])).toBe(true);
  }
  const byName = new Map(nodes.map((n) => [n.name, n]));
  expect(nodes.some((n) => registry.get(n.type)!.description.group === 'trigger')).toBe(true);
  for (const [source, byType] of Object.entries(connections)) {
    const src = byName.get(source);
    expect(src, `connection from unknown node ${source}`).toBeDefined();
    for (const [type, lists] of Object.entries(byType)) {
      lists!.forEach((targets, outputIndex) => {
        for (const target of targets) {
          const dst = byName.get(target.node);
          expect(dst, `connection to unknown node ${target.node}`).toBeDefined();
          expect(target.type).toBe(type);
          if (type === 'main') {
            expect(outputIndex).toBeLessThan(registry.outputsFor(src!).length);
            expect(target.index).toBeLessThan(registry.inputsFor(dst!).length);
          }
        }
      });
    }
  }
  expect([...res.order].sort()).toEqual([...names].sort());
  assertNoOverlap(nodes.map((n) => ({ name: n.name, x: n.position[0], y: n.position[1] })));
}

function assertNoOverlap(boxes: Box[]) {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const overlap = Math.abs(a.x - b.x) < 100 && Math.abs(a.y - b.y) < 100;
      expect(overlap, `${a.name} overlaps ${b.name}`).toBe(false);
    }
  }
}

async function runIt(res: BuildWorkflowResponse, query = '') {
  const run = await agent.post(`/api/dev/run${query}`).send(res.workflow);
  expect(run.status, JSON.stringify(run.body)).toBe(200);
  return run.body as { status: string; error?: { message: string }; nodes: { node: string; status: string }[]; output: JsonObject[][] };
}

describe('AI Workflow Builder: Gemini answers', () => {
  it('turns a valid answer into a runnable FlowForge workflow (source ai)', async () => {
    await start();
    await saveGemini();
    mock.enqueue(reply(SIMPLE));
    const { status, body } = await build('Make two numbers and double them');
    expect(status).toBe(200);
    expect(body).toMatchObject({ source: 'ai', label: AI_LABEL, notes: ['Click Execute Workflow to run it.'], missingCredentials: [] });
    expect(body.reason).toBeUndefined();
    expect(body.template).toBeUndefined();
    expect(body.workflow.name).toBe('Count');
    expect(body.order).toEqual(['Start', 'Make numbers', 'Double']);
    expect(body.workflow.connections['Make numbers']).toEqual({ main: [[{ node: 'Double', type: 'main', index: 0 }]] });
    assertRunnable(body);
    expect(mock.calls).toHaveLength(1);

    const run = await runIt(body);
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(run.output[0]).toEqual([{ n: 1, double: 2 }, { n: 2, double: 4 }]);
  });

  it('asks Gemini for JSON with the catalog and the user text only', async () => {
    await start();
    await saveGemini();
    mock.enqueue(reply(SIMPLE));
    await build('Make two numbers and double them');
    const call = mock.calls[0]!;
    expect(call.body.generationConfig).toMatchObject({ responseMimeType: 'application/json', temperature: 0.2 });
    const system: string = call.body.systemInstruction.parts[0].text;
    expect(system).toContain('flowforge.httpRequest');
    expect(system).toContain('flowforge.manualTrigger');
    expect(system).not.toContain('flowforge.stickyNote');
    expect(system).not.toContain('test.aiHarness');
    expect(call.body.contents).toEqual([{ role: 'user', parts: [{ text: 'User request:\nMake two numbers and double them' }] }]);
  });

  it('repairs once: the retry carries the previous answer and the numbered error list', async () => {
    await start();
    await saveGemini();
    const broken = {
      nodes: [
        { name: 'Start', type: 'flowforge.manualTrigger', parameters: {} },
        { name: 'Magic', type: 'flowforge.doesNotExist', parameters: {} },
        { name: 'Check', type: 'flowforge.if', parameters: {} },
        { name: 'After', type: 'flowforge.noOp', parameters: {} },
      ],
      connections: [
        { from: 'Start', to: 'Magic' },
        { from: 'Check', to: 'After', fromOutput: 5 },
      ],
    };
    mock.enqueue(reply(broken), reply(SIMPLE));
    const { body } = await build('do something magic');
    expect(body.source).toBe('ai');
    assertRunnable(body);
    expect(mock.calls).toHaveLength(2);
    const second = mock.calls[1]!.body;
    const texts: string[] = second.contents.map((c: { parts: { text: string }[] }) => c.parts[0]!.text);
    expect(second.contents.map((c: { role: string }) => c.role)).toEqual(['user', 'model', 'user']);
    expect(texts[1]).toBe(JSON.stringify(broken));
    expect(texts[2]).toContain('1. Node "Magic": the type "flowforge.doesNotExist" does not exist. Closest valid types:');
    expect(texts[2]).toMatch(/\n2\. .*fromOutput 5 does not exist/);
    expect(second.systemInstruction.parts[0].text).toContain('flowforge.httpRequest');
  });

  it('fixes obvious type variants: n8n-nodes-base.httpRequest, "HTTP Request", httpRequest', async () => {
    await start();
    const catalog = buildCatalog(t.ctx.registry);
    for (const variant of ['n8n-nodes-base.httpRequest', 'HTTP Request', 'httpRequest', 'flowforge.HTTPREQUEST', 'HttpRequest']) {
      expect(resolveNodeType(variant, catalog).type, variant).toBe('flowforge.httpRequest');
    }
    expect(resolveNodeType('n8n-nodes-base.manualTrigger', catalog).type).toBe('flowforge.manualTrigger');
    expect(resolveNodeType('Edit Fields', catalog).type).toBe('flowforge.set');
    expect(resolveNodeType('n8n-nodes-base.nopeNope', catalog).type).toBeUndefined();

    mock.calls.length = 0;
    await saveGemini();
    mock.enqueue(
      reply({
        nodes: [
          { name: 'Start', type: 'Manual Trigger' },
          { name: 'A', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://example.com' } },
          { name: 'B', type: 'HTTP Request', parameters: { url: 'https://example.org' } },
          { name: 'C', type: 'httpRequest', parameters: { url: 'https://example.net' } },
        ],
        connections: [
          { from: 'Start', to: 'A' },
          { from: 'A', to: 'B' },
          { from: 'B', to: 'C' },
        ],
      }),
    );
    const { body } = await build('three http calls');
    expect(body.source).toBe('ai');
    expect(body.workflow.nodes.map((n) => n.type)).toEqual(['flowforge.manualTrigger', 'flowforge.httpRequest', 'flowforge.httpRequest', 'flowforge.httpRequest']);
    expect(mock.calls).toHaveLength(1);
  });

  it('unknown node type in both answers: offline template, and the response has no unknown type', async () => {
    await start();
    await saveGemini();
    const bad = { nodes: [{ name: 'Start', type: 'flowforge.manualTrigger' }, { name: 'X', type: 'flowforge.teleporter' }], connections: [{ from: 'Start', to: 'X' }] };
    mock.enqueue(reply(bad), reply(bad));
    const { status, body } = await build('Send the weather by email every morning');
    expect(status).toBe(200);
    expect(mock.calls).toHaveLength(2);
    expect(body).toMatchObject({ source: 'offline', label: 'Offline: closest template', reason: "Gemini's answer was not a valid workflow" });
    expect(body.template).toMatchObject({ id: 'daily-weather-email', weak: false });
    for (const n of body.workflow.nodes) expect(t.ctx.registry.get(n.type), n.type).toBeDefined();
    expect(JSON.stringify(body)).not.toContain('teleporter');
    assertRunnable(body);
  });

  it('answers that are not JSON, twice: offline template (the retry quotes the start of the first answer)', async () => {
    await start();
    await saveGemini();
    mock.enqueue(reply('Sure! Here is your workflow: {nodes: ['), reply('still not json'));
    const { body } = await build('hello world please');
    expect(mock.calls).toHaveLength(2);
    const texts = mock.calls[1]!.body.contents.map((c: { parts: { text: string }[] }) => c.parts[0]!.text);
    expect(texts[1]).toContain('Sure! Here is your workflow');
    expect(texts[2]).toContain('1. The answer is not valid JSON');
    expect(body).toMatchObject({ source: 'offline', label: OFFLINE_LABEL, reason: "Gemini's answer was not a valid workflow" });
    assertRunnable(body);
  });

  it('a wrong first answer then a service error: offline with the service reason', async () => {
    await start();
    await saveGemini();
    mock.enqueue(reply({ nodes: [] }), apiError(429, 'quota', [], 'RESOURCE_EXHAUSTED'), apiError(429, 'quota', [], 'RESOURCE_EXHAUSTED'));
    const { body } = await build('anything at all');
    expect(body.source).toBe('offline');
    expect(body.reason).toMatch(/rate limit/i);
  });
});

describe('AI Workflow Builder: offline fallback when Gemini cannot be used', () => {
  it('no credential: offline, no call to Gemini, reason says how to fix it', async () => {
    await start();
    const { status, body } = await build('Alert me on Discord when my website is down');
    expect(status).toBe(200);
    expect(mock.calls).toHaveLength(0);
    expect(body).toMatchObject({ source: 'offline', label: 'Offline: closest template' });
    expect(body.reason).toMatch(/No Google Gemini API key/);
    expect(body.template).toMatchObject({ id: 'builtin-website-down-alert', weak: false });
    expect(body.template!.score).toBeGreaterThan(WEAK_SCORE);
    assertRunnable(body);
  });

  it('429: offline with a rate-limit reason', async () => {
    await start();
    await saveGemini();
    mock.enqueue(apiError(429, 'Quota exceeded', [], 'RESOURCE_EXHAUSTED'), apiError(429, 'Quota exceeded', [], 'RESOURCE_EXHAUSTED'));
    const { body } = await build('Send new RSS articles to Telegram');
    expect(body).toMatchObject({ source: 'offline', label: OFFLINE_LABEL });
    expect(body.reason).toMatch(/rate limit/i);
    expect(body.template?.id).toBe('builtin-rss-to-telegram');
    assertRunnable(body);
  });

  it('5xx: offline, unavailable reason', async () => {
    await start();
    await saveGemini();
    mock.enqueue(apiError(503, 'overloaded'), apiError(503, 'overloaded'));
    const { body } = await build('Send new RSS articles to Telegram');
    expect(body.source).toBe('offline');
    expect(body.reason).toMatch(/unavailable/i);
  });

  it('invalid key (400): offline, key rejected', async () => {
    await start();
    await saveGemini();
    mock.enqueue(apiError(400, 'API key not valid. Please pass a valid API key.', [{ reason: 'API_KEY_INVALID' }], 'INVALID_ARGUMENT'));
    const { body } = await build('Send new RSS articles to Telegram');
    expect(body.source).toBe('offline');
    expect(body.reason).toMatch(/rejected the API key/i);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it('blocked prompt: offline, safety reason', async () => {
    await start();
    await saveGemini();
    mock.enqueue({ body: { promptFeedback: { blockReason: 'SAFETY' } } });
    const { body } = await build('Send new RSS articles to Telegram');
    expect(body.source).toBe('offline');
    expect(body.reason).toMatch(/safety/i);
  });

  it('timeout: offline, "did not answer in time"', async () => {
    await start();
    await saveGemini();
    mock.enqueue({ ...reply(SIMPLE), delayMs: 800 });
    const body = await buildWorkflow('Send new RSS articles to Telegram', deps({ timeoutMs: 150 }));
    expect(body).toMatchObject({ source: 'offline', label: OFFLINE_LABEL, reason: 'Gemini did not answer in time.' });
    assertRunnable(body);
  });
});

describe('AI Workflow Builder: validation and cluster nodes', () => {
  /** Agent-like cluster with a required Chat Model, registered under test.* so the validator proves it is generic. */
  async function clusterRegistry() {
    const registry = new NodeRegistry();
    const hidden = { icon: 'lucide:box', version: 1, hidden: false };
    registry.register(defineNode({ description: { ...hidden, type: 'cl.start', displayName: 'Start', description: 'trigger', group: 'trigger', trigger: { kind: 'manual' }, defaults: { name: 'Start' }, inputs: [], outputs: [{ type: 'main' }] }, properties: [], execute: () => [[{ json: {} }]] }));
    registry.register(
      defineNode({
        description: {
          ...hidden,
          type: 'cl.agent',
          displayName: 'Agent',
          description: 'Agent with AI slots',
          group: 'ai',
          defaults: { name: 'Agent' },
          inputs: [{ type: 'main' }, { type: 'ai_languageModel', displayName: 'Chat Model', required: true, maxConnections: 1 }, { type: 'ai_memory', maxConnections: 1 }, { type: 'ai_tool' }],
          outputs: [{ type: 'main' }],
        },
        properties: [{ name: 'prompt', displayName: 'Prompt', type: 'string', default: '', required: true }],
        execute: () => [[{ json: {} }]],
      }),
    );
    for (const [kind, ai] of [['model', 'ai_languageModel'], ['memory', 'ai_memory'], ['tool', 'ai_tool']] as const) {
      registry.register(
        defineNode({
          description: { ...hidden, type: `cl.${kind}`, displayName: `Sub ${kind}`, description: `sub-node ${kind}`, group: 'ai-sub', defaults: { name: `Sub ${kind}` }, inputs: [], outputs: [{ type: ai }] },
          properties: [],
          supplyData: () => ({}) as never,
        }),
      );
    }
    return registry;
  }

  const ctxFor = (registry: NodeRegistry): ValidateContext => ({ registry, catalog: buildCatalog(registry) });
  const cluster = (overrides: { skip?: string; extra?: object[]; extraConnections?: object[] } = {}) => ({
    nodes: [
      { name: 'Start', type: 'cl.start' },
      { name: 'Agent', type: 'cl.agent', parameters: { prompt: 'Help the user' } },
      ...(overrides.skip === 'model' ? [] : [{ name: 'Model', type: 'cl.model' }]),
      { name: 'Memory', type: 'cl.memory' },
      { name: 'Tool A', type: 'cl.tool' },
      { name: 'Tool B', type: 'cl.tool' },
      ...(overrides.extra ?? []),
    ],
    connections: [
      { from: 'Start', to: 'Agent' },
      ...(overrides.skip === 'model' ? [] : [{ from: 'Model', to: 'Agent' }]),
      { from: 'Memory', to: 'Agent' },
      { from: 'Tool A', to: 'Agent', type: 'ai_tool' },
      { from: 'Tool B', to: 'Agent' },
      ...(overrides.extraConnections ?? []),
    ],
  });

  it('accepts an agent with model, memory and tools; sub-nodes connect FROM the sub-node TO the parent', async () => {
    const registry = await clusterRegistry();
    const result = validateWorkflow(cluster(), ctxFor(registry));
    expect(result.errors).toEqual([]);
    const wf = result.workflow!;
    expect(wf.connections['Model']).toEqual({ ai_languageModel: [[{ node: 'Agent', type: 'ai_languageModel', index: 0 }]] });
    expect(wf.connections['Tool A']).toEqual({ ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] });
    expect(wf.connections['Start']).toEqual({ main: [[{ node: 'Agent', type: 'main', index: 0 }]] });

    layoutNodes(wf.nodes, wf.connections);
    const pos = new Map(wf.nodes.map((n) => [n.name, n.position]));
    const agentPos = pos.get('Agent')!;
    const row = ['Model', 'Memory', 'Tool A', 'Tool B'].map((n) => pos.get(n)!);
    for (const p of row) expect(p[1]).toBe(row[0]![1]);
    expect(row[0]![1]).toBeGreaterThan(agentPos[1] + 100);
    expect(row.map((p) => p[0])).toEqual([...row.map((p) => p[0])].sort((a, b) => a - b));
    const centre = (row[0]![0] + row[3]![0]) / 2;
    expect(Math.abs(centre - agentPos[0])).toBeLessThanOrEqual(20);
    assertNoOverlap(wf.nodes.map((n) => ({ name: n.name, x: n.position[0], y: n.position[1] })));
    expect(nodeOrder(wf, registry)).toEqual(['Start', 'Agent', 'Model', 'Memory', 'Tool A', 'Tool B']);
  });

  it('refuses: missing required model, 2nd model (max 1), unattached sub-node, sub-node on a node without slot, wrong type', async () => {
    const registry = await clusterRegistry();
    const ctx = ctxFor(registry);
    expect(validateWorkflow(cluster({ skip: 'model' }), ctx).errors.join('\n')).toContain('Node "Agent" needs a "ai_languageModel" sub-node');
    expect(validateWorkflow(cluster({ extra: [{ name: 'Model 2', type: 'cl.model' }], extraConnections: [{ from: 'Model 2', to: 'Agent' }] }), ctx).errors.join('\n')).toContain('accepts at most 1 "ai_languageModel"');
    expect(validateWorkflow(cluster({ extra: [{ name: 'Lonely', type: 'cl.tool' }] }), ctx).errors.join('\n')).toContain('Sub-node "Lonely" is not attached');
    expect(validateWorkflow(cluster({ extraConnections: [{ from: 'Tool A', to: 'Start', type: 'ai_tool' }] }), ctx).errors.join('\n')).toContain('"Start" has no "ai_tool" slot');
    expect(validateWorkflow(cluster({ extraConnections: [{ from: 'Tool A', to: 'Agent', type: 'ai_memory' }] }), ctx).errors.join('\n')).toContain('does not supply "ai_memory"');
    expect(validateWorkflow(cluster({ extraConnections: [{ from: 'Tool A', to: 'Agent', type: 'main' }] }), ctx).errors.join('\n')).toContain('is an AI sub-node');
    const noPrompt = cluster();
    (noPrompt.nodes.find((n) => (n as { name: string }).name === 'Agent') as { parameters?: object }).parameters = {};
    expect(validateWorkflow(noPrompt, ctx).errors.join('\n')).toContain('required parameter "prompt"');
  });

  it('missing Chat Model through the whole pipeline: the retry lists the problem, then offline', async () => {
    await start();
    await saveGemini();
    const registry = await clusterRegistry();
    // The offline templates need the real nodes, so this registry (cluster only) cannot supply one: use the real one for the fallback.
    const wrong = cluster({ skip: 'model' });
    mock.enqueue(reply(wrong), reply(wrong));
    const body = await buildWorkflow('an agent', deps({ registry: await mergedRegistry(registry) }));
    expect(body.source).toBe('offline');
    expect(JSON.stringify(mock.calls[1]!.body)).toContain('needs a \\"ai_languageModel\\" sub-node');
  });

  /** Real nodes + the cluster test nodes. */
  async function mergedRegistry(cl: NodeRegistry) {
    const merged = new NodeRegistry();
    const real = await getTestRegistry();
    for (const info of real.list(true)) merged.register(real.require(info.type));
    for (const info of cl.list(true)) merged.register(cl.require(info.type));
    return merged;
  }

  it('real test cluster nodes (includeHidden): generated agent workflow runs through the engine', async () => {
    await start();
    await saveGemini();
    mock.enqueue(
      reply({
        nodes: [
          { name: 'Start', type: 'flowforge.manualTrigger' },
          { name: 'Harness', type: 'test.aiHarness', parameters: { tool: 'echo', args: { text: 'hi' } } },
          { name: 'Echo', type: 'test.fakeTool', parameters: { toolName: 'echo', prefix: 'P' } },
        ],
        connections: [
          { from: 'Start', to: 'Harness' },
          { from: 'Echo', to: 'Harness' },
        ],
      }),
    );
    const body = await buildWorkflow('use the harness', deps({ includeHidden: true }));
    expect(body.source).toBe('ai');
    expect(body.order).toEqual(['Start', 'Harness', 'Echo']);
    assertRunnable(body);
    const run = await runIt(body);
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(run.output[0]![0]).toMatchObject({ tools: ['echo'], hasModel: false, result: { echoed: expect.stringContaining('hi'), prefix: 'P' } });
    // Without includeHidden the same answer names an unknown type.
    mock.enqueue(reply({ nodes: [{ name: 'Start', type: 'flowforge.manualTrigger' }, { name: 'H', type: 'test.aiHarness' }], connections: [{ from: 'Start', to: 'H' }] }));
    mock.enqueue(reply({ nodes: [{ name: 'Start', type: 'flowforge.manualTrigger' }, { name: 'H', type: 'test.aiHarness' }], connections: [{ from: 'Start', to: 'H' }] }));
    const hiddenOff = await buildWorkflow('use the harness', deps());
    expect(hiddenOff.source).toBe('offline');
  });

  it('checks parameters: unknown names dropped, bad option, required missing, expression marker repaired', async () => {
    await start();
    const ctx = ctxFor(t.ctx.registry);
    const ok = validateWorkflow(
      {
        nodes: [
          { name: 'Start', type: 'flowforge.manualTrigger' },
          { name: 'Get', type: 'flowforge.httpRequest', parameters: { url: 'https://example.com/{{ $json.id }}', method: 'get', nonsense: 1, options: { timeout: '5000', bogus: true } } },
        ],
        connections: [{ from: 'Start', to: 'Get' }],
      },
      ctx,
    );
    expect(ok.errors).toEqual([]);
    expect(ok.workflow!.nodes[1]!.parameters).toEqual({ url: '=https://example.com/{{ $json.id }}', method: 'GET', options: { timeout: 5000 } });

    const bad = validateWorkflow(
      {
        nodes: [
          { name: 'Start', type: 'flowforge.manualTrigger' },
          { name: 'Get', type: 'flowforge.httpRequest', parameters: { method: 'FETCH' } },
        ],
        connections: [{ from: 'Start', to: 'Get' }],
      },
      ctx,
    );
    expect(bad.errors.join('\n')).toContain('must be one of: GET, POST');
    expect(bad.errors.join('\n')).toContain('required parameter "url"');
  });

  it('checks the graph: trigger, reachability, loops, self loop, inputs, duplicates, size', async () => {
    await start();
    const ctx = ctxFor(t.ctx.registry);
    const n = (name: string, type = 'flowforge.noOp') => ({ name, type });
    const errs = (raw: unknown) => validateWorkflow(raw, ctx).errors.join('\n');
    expect(errs({ nodes: [n('A')], connections: [] })).toContain('no trigger node');
    expect(errs({ nodes: [n('S', 'flowforge.manualTrigger'), n('A'), n('B')], connections: [{ from: 'S', to: 'A' }] })).toContain('Node "B" is not reachable');
    expect(errs({ nodes: [n('S', 'flowforge.manualTrigger'), n('A'), n('B')], connections: [{ from: 'S', to: 'A' }, { from: 'A', to: 'B' }, { from: 'B', to: 'A' }] })).toContain('form a loop');
    expect(errs({ nodes: [n('S', 'flowforge.manualTrigger'), n('A')], connections: [{ from: 'S', to: 'A' }, { from: 'A', to: 'A' }] })).toContain('cannot connect to itself');
    expect(errs({ nodes: [n('S', 'flowforge.manualTrigger'), n('A')], connections: [{ from: 'A', to: 'S' }, { from: 'S', to: 'A' }] })).toContain('nothing connects into it');
    expect(errs({ nodes: [n('S', 'flowforge.manualTrigger'), n('A')], connections: [{ from: 'S', to: 'A', toInput: 1 }] })).toContain('toInput 1 does not exist');
    expect(errs({ nodes: [n('S', 'flowforge.manualTrigger'), n('S')], connections: [] })).toContain('Duplicate node name "S"');
    expect(errs({ nodes: [n('S', 'flowforge.manualTrigger'), n('A')], connections: [{ from: 'S', to: 'Ghost' }] })).toContain('"Ghost" is not a node');
    expect(errs({ nodes: Array.from({ length: 31 }, (_, i) => n(`N${i}`, i ? 'flowforge.noOp' : 'flowforge.manualTrigger')), connections: [] })).toContain('limit is 30');
    expect(errs({ nodes: [], connections: [] })).toContain('no nodes');
    expect(errs('hello')).toContain('JSON shape');
    expect(errs({ nodes: [{ name: '__proto__', type: 'flowforge.noOp' }], connections: [] })).toContain('not allowed');

    // IF has 2 outputs: output 1 is fine, output 2 is not. A loop through Loop Over Items is allowed.
    const iff = (out: number) => ({
      nodes: [n('S', 'flowforge.manualTrigger'), n('Q', 'flowforge.if'), n('A')],
      connections: [{ from: 'S', to: 'Q' }, { from: 'Q', to: 'A', fromOutput: out }],
    });
    expect(errs(iff(1))).toBe('');
    expect(errs(iff(2))).toContain('has 2 output(s)');
    const loop = { nodes: [n('S', 'flowforge.manualTrigger'), n('L', 'flowforge.splitInBatches'), n('W')], connections: [{ from: 'S', to: 'L' }, { from: 'L', to: 'W', fromOutput: 1 }, { from: 'W', to: 'L' }] };
    expect(errs(loop)).toBe('');
  });

  it('the example in the prompt is itself valid', async () => {
    await start();
    expect(validateWorkflow(EXAMPLE_ANSWER, ctxFor(t.ctx.registry)).errors).toEqual([]);
  });
});

describe('AI Workflow Builder: catalog, templates, layout', () => {
  it('catalog is built from the registry, small, without notes and hidden nodes', async () => {
    const registry = await getTestRegistry();
    const catalog = buildCatalog(registry);
    expect(catalog.text.length).toBeLessThanOrEqual(CATALOG_MAX_CHARS);
    expect(catalog.byType.has('flowforge.stickyNote')).toBe(false);
    expect(catalog.byType.has('test.aiHarness')).toBe(false);
    for (const type of ['flowforge.manualTrigger', 'flowforge.webhook', 'flowforge.httpRequest', 'flowforge.if', 'flowforge.set', 'flowforge.code', 'flowforge.telegram', 'flowforge.discord', 'flowforge.sendEmail']) {
      expect(catalog.byType.has(type), type).toBe(true);
      expect(catalog.text).toContain(type);
    }
    // the shapes the model needs
    const iff = catalog.byType.get('flowforge.if')!;
    expect(iff.outputs).toEqual(['true', 'false']);
    expect(catalog.byType.get('flowforge.httpRequest')!.params.find((p) => p.name === 'url')!.required).toBe(true);
    console.log(`catalog: ${catalog.entries.length} nodes, ${catalog.text.length} characters`);

    const withHidden = buildCatalog(registry, { includeHidden: true });
    expect(withHidden.byType.get('test.aiHarness')!.aiSlots.map((s) => s.type)).toEqual(['ai_languageModel', 'ai_memory', 'ai_tool']);
    expect(withHidden.byType.get('test.fakeTool')!.aiOutput).toBe('ai_tool');
    expect(withHidden.text).toContain('SUB-NODE supplying ai_tool');
    expect(buildCatalog(registry, { maxChars: 3000 }).text.length).toBeLessThanOrEqual(3000);
  });

  it('every built-in template and every example validates against the registry', async () => {
    const registry = await getTestRegistry();
    const ctx: ValidateContext = { registry, catalog: buildCatalog(registry) };
    const templates = loadTemplates(EXAMPLES_DIR, registry);
    expect(templates.length).toBeGreaterThanOrEqual(BUILT_IN_TEMPLATES.length + 5);
    for (const template of templates) {
      const result = validateWorkflow(template.workflow, ctx);
      expect(result.errors, template.id).toEqual([]);
      layoutNodes(result.workflow!.nodes, result.workflow!.connections);
      assertNoOverlap(result.workflow!.nodes.map((nd) => ({ name: nd.name, x: nd.position[0], y: nd.position[1] })));
    }
    for (const type of BUILT_IN_TEMPLATES.flatMap((b) => b.workflow.nodes.map((nd) => nd.type))) expect(registry.get(type), type).toBeDefined();
    // webhook-kind triggers get a webhookId
    const form = validateWorkflow(templates.find((x) => x.id === 'form-to-email')!.workflow, ctx).workflow!;
    expect(form.nodes.find((nd) => nd.type === 'flowforge.formTrigger')!.webhookId).toBeTruthy();
    expect(form.nodes.some((nd) => nd.type === 'flowforge.stickyNote')).toBe(false);
  });

  it('built-in templates run (hello world) and the website-down check branches correctly', async () => {
    await start();
    const hello = await buildWorkflow('hello world', deps());
    expect(hello.template?.id).toBe('builtin-hello-world');
    const run = await runIt(hello);
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(run.output[0]).toEqual([{ greeting: 'Hello from FlowForge!' }]);

    // Website-down: point the check at a closed port; the error is kept as an item and the IF sends it to "true".
    const down = await buildWorkflow('website down alert', deps());
    expect(down.template?.id).toBe('builtin-website-down-alert');
    const wf = structuredClone(down.workflow);
    wf.nodes.find((nd) => nd.name === 'Check website')!.parameters.url = 'http://127.0.0.1:9';
    const res = await agent.post('/api/dev/run?destinationNode=Is%20it%20down%3F').send(wf);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status, JSON.stringify(res.body.error)).toBe('success');
    expect(res.body.output[0]).toHaveLength(1);
    expect(res.body.output[1] ?? []).toHaveLength(0);
  });

  it('layout: left to right, integers, no overlaps, branches and sub-nodes never collide', async () => {
    const registry = await getTestRegistry();
    const ctx: ValidateContext = { registry, catalog: buildCatalog(registry, { includeHidden: true }) };
    const nodes = [
      { name: 'T', type: 'flowforge.manualTrigger' },
      { name: 'Q', type: 'flowforge.if' },
      { name: 'H1', type: 'test.aiHarness' },
      { name: 'H2', type: 'test.aiHarness' },
      ...[1, 2, 3, 4].map((i) => ({ name: `F${i}`, type: 'test.fakeTool' })),
      { name: 'Z', type: 'flowforge.noOp' },
    ];
    const connections = [
      { from: 'T', to: 'Q' },
      { from: 'Q', to: 'H1', fromOutput: 0 },
      { from: 'Q', to: 'H2', fromOutput: 1 },
      { from: 'H1', to: 'Z' },
      { from: 'H2', to: 'Z' },
      ...[1, 2, 3].map((i) => ({ from: `F${i}`, to: 'H1' })),
      { from: 'F4', to: 'H2' },
    ];
    const result = validateWorkflow({ nodes, connections }, ctx);
    expect(result.errors).toEqual([]);
    const wf = result.workflow!;
    layoutNodes(wf.nodes, wf.connections);
    const p = new Map(wf.nodes.map((nd) => [nd.name, nd.position]));
    for (const nd of wf.nodes) expect(nd.position.every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
    assertNoOverlap(wf.nodes.map((nd) => ({ name: nd.name, x: nd.position[0], y: nd.position[1] })));
    expect(p.get('T')![0]).toBeLessThan(p.get('Q')![0]);
    expect(p.get('Q')![0]).toBeLessThan(p.get('H1')![0]);
    expect(p.get('H1')![0]).toBeLessThan(p.get('Z')![0]);
    expect(p.get('F1')![1]).toBeGreaterThan(p.get('H1')![1]);
    expect(p.get('F4')![1]).toBeGreaterThan(p.get('H2')![1]);
  });
});

describe('AI Workflow Builder: credentials, secrets, request validation', () => {
  it('lists the credentials the workflow still needs', async () => {
    await start();
    await saveGemini();
    mock.enqueue(
      reply({
        name: 'Notify',
        nodes: [
          { name: 'Start', type: 'flowforge.manualTrigger' },
          { name: 'Mail', type: 'flowforge.sendEmail', parameters: { toEmail: 'you@example.com', subject: 'Hi', emailFormat: 'text', text: 'Hello' } },
          { name: 'Chat', type: 'flowforge.telegram', parameters: { operation: 'sendMessage', chatId: 'YOUR_CHAT_ID', text: 'Hello' } },
          { name: 'Pause', type: 'flowforge.noOp' },
        ],
        connections: [
          { from: 'Start', to: 'Mail' },
          { from: 'Mail', to: 'Chat' },
          { from: 'Chat', to: 'Pause' },
        ],
        notes: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'x'.repeat(300)],
      }),
    );
    const { body } = await build('mail then telegram');
    expect(body.source).toBe('ai');
    expect(body.missingCredentials).toEqual([
      { node: 'Mail', credentialType: 'smtp', displayName: expect.any(String) },
      { node: 'Chat', credentialType: 'telegramApi', displayName: expect.any(String) },
    ]);
    expect(body.missingCredentials[0]!.displayName.length).toBeGreaterThan(2);
    expect(body.notes.slice(0, 5)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(body.notes).toHaveLength(7);
    expect(body.notes[5]).toContain('"Mail" needs a');
    expect(body.notes[6]).toContain('"Chat" needs a');
    assertRunnable(body);

    // once the Telegram credential exists it is no longer missing
    const cred = await agent.post('/api/credentials').send({ name: 'Bot', type: 'telegramApi', data: { accessToken: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11' } });
    expect(cred.status, JSON.stringify(cred.body)).toBe(201);
    mock.enqueue(reply({ nodes: [{ name: 'Start', type: 'flowforge.manualTrigger' }, { name: 'Chat', type: 'flowforge.telegram', parameters: { chatId: '1', text: 'x' } }], connections: [{ from: 'Start', to: 'Chat' }] }));
    const again = await build('telegram message');
    expect(again.body.missingCredentials).toEqual([]);
  });

  it('prompts and logs never contain credential values', async () => {
    await start();
    await saveGemini();
    const bearer = await agent.post('/api/credentials').send({ name: 'Other API', type: 'httpBearerAuth', data: { token: OTHER_SECRET } });
    expect(bearer.status, JSON.stringify(bearer.body)).toBe(201);

    mock.enqueue(reply(SIMPLE));
    await build('Make two numbers and double them');
    // success, then a failing run (429) and a broken-answer run
    mock.enqueue(apiError(429, `quota for key ${KEY}`, [], 'RESOURCE_EXHAUSTED'), apiError(429, `quota for key ${KEY}`, [], 'RESOURCE_EXHAUSTED'));
    const limited = await build('Send new RSS articles to Telegram');
    mock.enqueue(reply({ nodes: [{ name: 'a', type: 'nope' }] }), reply('not json'));
    await build('another try');

    expect(mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const call of mock.calls) {
      expect(call.raw).not.toContain(KEY);
      expect(call.raw).not.toContain(OTHER_SECRET);
      expect(call.raw).not.toContain('apiKey');
      expect(call.url).not.toContain(KEY);
    }
    expect(JSON.stringify(limited)).not.toContain(KEY);
    const logs = logger.lines.join('\n');
    expect(logs).toContain('AI Workflow Builder');
    expect(logs).not.toContain(KEY);
    expect(logs).not.toContain(OTHER_SECRET);
    expect(logs).not.toContain('Make two numbers');
    expect(logs).not.toContain('User request');
    expect(logger.lines.some((l) => l.startsWith('info') && l.includes('Make two'))).toBe(false);
  });

  it('rejects prompts that are too short, too long or missing; needs a login', async () => {
    await start();
    expect((await agent.post('/api/ai/build-workflow').send({ prompt: 'ab' })).status).toBe(400);
    expect((await agent.post('/api/ai/build-workflow').send({ prompt: '   x   ' })).status).toBe(400);
    expect((await agent.post('/api/ai/build-workflow').send({ prompt: 'x'.repeat(2001) })).status).toBe(400);
    expect((await agent.post('/api/ai/build-workflow').send({})).status).toBe(400);
    expect((await agent.post('/api/ai/build-workflow').send({ prompt: 42 })).status).toBe(400);
    const ok = await agent.post('/api/ai/build-workflow').send({ prompt: 'x'.repeat(2000) });
    expect(ok.status).toBe(200);
    const anonymous = await (await import('supertest')).default(t.app).post('/api/ai/build-workflow').send({ prompt: 'hello world' });
    expect(anonymous.status).toBe(401);
  });

  it('a decrypt/credential problem is a fallback, not a crash', async () => {
    await start();
    const failing = { resolve: () => { throw new MissingCredentialError('googlePalmApi', 'Google Gemini API'); } };
    const body = await buildWorkflow('hello world', deps({ credentials: failing as never }));
    expect(body.source).toBe('offline');
    expect(body.missingCredentials).toEqual([]);
  });
});

describe('AI Workflow Builder: offline scorer on sample prompts', () => {
  const SAMPLES: { prompt: string; expect?: string; weak?: boolean }[] = [
    { prompt: 'Every morning send me the weather forecast by email', expect: 'daily-weather-email' },
    { prompt: 'When someone fills in my contact form, post the message to Discord', expect: 'contact-form-discord' },
    { prompt: 'A Telegram bot that tells me the weather', expect: 'telegram-assistant' },
    { prompt: 'A chatbot for my website powered by Gemini', expect: 'website-chatbot' },
    { prompt: 'Alert me on Discord when my website is down', expect: 'builtin-website-down-alert' },
    { prompt: 'A webhook that answers with JSON', expect: 'builtin-webhook-json' },
    { prompt: 'Send every new RSS article to Telegram', expect: 'builtin-rss-to-telegram' },
    { prompt: 'Order me a pizza', weak: true },
    { prompt: 'Envoie-moi la météo par email chaque matin', expect: 'daily-weather-email' },
    { prompt: 'email' },
  ];

  it('picks the right template for 10 prompts (table printed) and is deterministic', async () => {
    const registry = await getTestRegistry();
    const templates = loadTemplates(EXAMPLES_DIR, registry);
    const lines: string[] = [];
    for (const sample of SAMPLES) {
      const ranked = rankTemplates(sample.prompt, templates);
      const again = rankTemplates(sample.prompt, templates);
      expect(again.map((r) => [r.template.id, r.score])).toEqual(ranked.map((r) => [r.template.id, r.score]));
      const best = ranked[0]!;
      lines.push(`${JSON.stringify(sample.prompt).padEnd(72)} -> ${best.template.id.padEnd(28)} score ${best.score.toFixed(3)} ${best.weak ? 'WEAK' : 'ok'}  (2nd: ${ranked[1]!.template.id} ${ranked[1]!.score.toFixed(3)})`);
      if (sample.expect) expect(best.template.id, sample.prompt).toBe(sample.expect);
      if (sample.expect) expect(best.weak, `${sample.prompt} should not be weak`).toBe(false);
      if (sample.weak) expect(best.weak, `${sample.prompt} should be weak`).toBe(true);
    }
    console.log(`\nOffline scorer (weak under ${WEAK_SCORE}):\n${lines.join('\n')}\n`);
  });

  it('through the pipeline: weak matches are labelled in the notes', async () => {
    await start();
    const body = await buildWorkflow('Order me a pizza', deps());
    expect(body).toMatchObject({ source: 'offline', label: OFFLINE_LABEL });
    expect(body.template!.weak).toBe(true);
    expect(body.notes.some((nn) => /loosely/.test(nn))).toBe(true);
    assertRunnable(body);
  });
});
