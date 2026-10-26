import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connections, Item, JsonObject, RunData, WorkflowData, WorkflowNode } from '@flowforge/shared';
import { BinaryStore } from '../src/engine/binary-store.js';
import { NodeOperationError } from '../src/engine/errors.js';
import { ExpressionEngine } from '../src/engine/expressions/engine.js';
import { WorkflowRunner, type RunnerDeps, type RunRequest, type RunResult } from '../src/engine/runner.js';
import { defineNode } from '../src/engine/types.js';
import { silentLogger } from '../src/logger.js';
import { loadNodeRegistry, type NodeRegistry } from '../src/nodes/registry.js';

/** How often each test node ran, keyed by its `key` parameter. */
export const counters = new Map<string, number>();
const flakyAttempts = new Map<string, number>();

const hidden = { hidden: true as const, version: 1, icon: 'lucide:flask-conical', inputs: [{ type: 'main' as const }], outputs: [{ type: 'main' as const }] };

/** Test-only nodes that make engine behaviour observable. */
const TEST_NODES = [
  defineNode({
    description: { ...hidden, type: 'test.emit', displayName: 'Emit', description: 'Outputs the items given in "items"', group: 'transform', defaults: { name: 'Emit' } },
    properties: [{ name: 'items', displayName: 'Items', type: 'json', default: [] }],
    execute: (ctx) => [(ctx.getNodeParameter<JsonObject[]>('items', 0, []) ?? []).map((json) => ({ json }))],
  }),
  defineNode({
    description: { ...hidden, type: 'test.counter', displayName: 'Counter', description: 'Counts runs, passes items through', group: 'transform', defaults: { name: 'Counter' } },
    properties: [{ name: 'key', displayName: 'Key', type: 'string', default: 'default' }],
    execute(ctx) {
      const key = String(ctx.getRawParameter('key'));
      counters.set(key, (counters.get(key) ?? 0) + 1);
      return [ctx.getInputData()];
    },
  }),
  defineNode({
    description: { ...hidden, type: 'test.flaky', displayName: 'Flaky', description: 'Fails N times, then succeeds', group: 'transform', defaults: { name: 'Flaky' } },
    properties: [
      { name: 'key', displayName: 'Key', type: 'string', default: 'flaky' },
      { name: 'failures', displayName: 'Failures', type: 'number', default: 2 },
    ],
    execute(ctx) {
      const key = String(ctx.getRawParameter('key'));
      const attempt = (flakyAttempts.get(key) ?? 0) + 1;
      flakyAttempts.set(key, attempt);
      if (attempt <= Number(ctx.getRawParameter('failures'))) throw new NodeOperationError(`Attempt ${attempt} failed`);
      return [ctx.getInputData().map((item) => ({ json: { ...item.json, attempts: attempt } }))];
    },
  }),
  defineNode({
    description: { ...hidden, type: 'test.fail', displayName: 'Fail', description: 'Fails (whole node or per item)', group: 'transform', defaults: { name: 'Fail' } },
    properties: [
      { name: 'message', displayName: 'Message', type: 'string', default: 'Boom' },
      { name: 'perItemField', displayName: 'Fail items where this field is true', type: 'string', default: '' },
    ],
    async execute(ctx) {
      const field = String(ctx.getRawParameter('perItemField') ?? '');
      if (!field) throw new NodeOperationError(String(ctx.getRawParameter('message')));
      return [
        await ctx.forEachItem((item) => {
          if (item.json[field] === true) throw new NodeOperationError(`Item ${String(item.json.id)} is bad`);
          return { json: { ...item.json, ok: true } };
        }),
      ];
    },
  }),
  defineNode({
    description: { ...hidden, type: 'test.slow', displayName: 'Slow', description: 'Waits before passing items on', group: 'transform', defaults: { name: 'Slow' } },
    properties: [{ name: 'ms', displayName: 'Milliseconds', type: 'number', default: 1000 }],
    execute: async (ctx) => {
      await new Promise((r) => setTimeout(r, Number(ctx.getRawParameter('ms'))));
      return [ctx.getInputData()];
    },
  }),
  defineNode({
    description: { ...hidden, type: 'test.makeFile', displayName: 'Make File', description: 'Creates a CSV file', group: 'transform', defaults: { name: 'Make File' } },
    properties: [],
    async execute(ctx) {
      const data = await ctx.helpers.prepareBinaryData(Buffer.from('a,b\n1,2'), 'table.csv');
      return [[{ json: { name: 'table' }, binary: { data } }]];
    },
  }),
  defineNode({
    description: { ...hidden, type: 'test.readFile', displayName: 'Read File', description: 'Reads binary data back', group: 'transform', defaults: { name: 'Read File' } },
    properties: [],
    async execute(ctx) {
      return [[{ json: { text: (await ctx.helpers.getBinaryDataBuffer(0, 'data')).toString() } }]];
    },
  }),
  // ── AI cluster test nodes: a parent that uses whatever is attached to its slots, and a minimal tool ──
  defineNode({
    description: {
      ...hidden,
      type: 'test.aiHarness',
      displayName: 'AI Harness',
      description: 'Calls one attached tool and reports what is attached',
      group: 'ai',
      defaults: { name: 'AI Harness' },
      inputs: [{ type: 'main' }, { type: 'ai_languageModel', maxConnections: 1 }, { type: 'ai_memory', maxConnections: 1 }, { type: 'ai_tool' }],
    },
    properties: [
      { name: 'tool', displayName: 'Tool', type: 'string', default: '' },
      { name: 'args', displayName: 'Arguments', type: 'json', default: {} },
    ],
    async execute(ctx) {
      const out = await ctx.forEachItem(async (_item, i) => {
        const [model, memory, tools] = [await ctx.getAiChatModel(i), await ctx.getAiMemory(i), await ctx.getAiTools(i)];
        const json: Record<string, unknown> = { tools: tools.map((t) => t.name), hasModel: Boolean(model), hasMemory: Boolean(memory) };
        const name = ctx.getNodeParameter<string>('tool', i, '');
        const tool = tools.find((t) => t.name === name);
        if (tool) {
          try {
            json.result = await tool.invoke(ctx.getNodeParameter('args', i, {}), { signal: ctx.signal });
          } catch (err) {
            json.toolError = (err as Error).message;
          }
        }
        return { json: json as never };
      });
      return [out];
    },
  }),
  defineNode({
    description: {
      ...hidden,
      type: 'test.fakeTool',
      displayName: 'Fake Tool',
      description: 'Echoes its arguments',
      group: 'ai-sub',
      defaults: { name: 'Fake Tool' },
      inputs: [],
      outputs: [{ type: 'ai_tool' }],
    },
    properties: [
      { name: 'toolName', displayName: 'Name', type: 'string', default: 'echo' },
      { name: 'prefix', displayName: 'Prefix', type: 'string', default: '' },
    ],
    supplyData(ctx, itemIndex) {
      const prefix = ctx.getNodeParameter<string>('prefix', itemIndex, '');
      if (prefix === 'BROKEN') throw new Error('The fake tool is misconfigured');
      return {
        name: ctx.getNodeParameter<string>('toolName', itemIndex, 'echo'),
        description: 'Echoes what it gets',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
        invoke: async (args) => {
          if (args.fail) throw new Error('tool exploded');
          return { echoed: args, prefix };
        },
      };
    },
  }),
  defineNode({
    description: { ...hidden, type: 'test.trigger', displayName: 'Test Trigger', description: 'Another trigger', group: 'trigger', inputs: [], defaults: { name: 'Test Trigger' } },
    properties: [],
    execute: () => [[{ json: { from: 'test trigger' } }]],
  }),
];

let registryPromise: Promise<NodeRegistry> | undefined;

export function getTestRegistry(): Promise<NodeRegistry> {
  registryPromise ??= loadNodeRegistry().then((registry) => {
    for (const node of TEST_NODES) registry.register(node);
    return registry;
  });
  return registryPromise;
}

let expressions: ExpressionEngine | undefined;

/** What the runner of a test gets besides the engine itself (file nodes, Execute Command, credentials). */
export interface RunnerExtras {
  filesRoot?: string;
  settings?: Record<string, unknown>;
  credentials?: RunnerDeps['credentials'];
  binaryStore?: BinaryStore;
}

export async function makeRunner(defaults: Partial<{ timeoutMs: number; maxNodeRuns: number; timezone: string }> = {}, extras: RunnerExtras = {}): Promise<WorkflowRunner> {
  expressions ??= new ExpressionEngine();
  return new WorkflowRunner({
    registry: await getTestRegistry(),
    expressions,
    binaryStore: extras.binaryStore ?? new BinaryStore(mkdtempSync(join(tmpdir(), 'ff-bin-'))),
    logger: silentLogger,
    defaults: { timeoutMs: 30_000, maxNodeRuns: 1000, timezone: 'UTC', ...defaults },
    filesRoot: extras.filesRoot,
    instanceSettings: extras.settings ? { get: (key) => extras.settings![key] } : undefined,
    credentials: extras.credentials,
  });
}

/** [name, type, parameters?, extra node fields? (position, settings…)] */
export type NodeSpec = [string, string, JsonObject?, Partial<WorkflowNode>?];
/** [from, to, outputIndex = 0, inputIndex = 0] */
export type EdgeSpec = [string, string, number?, number?];

/** Short type names → full node types. */
const TYPE_ALIASES: Record<string, string> = {
  manual: 'flowforge.manualTrigger',
  set: 'flowforge.set',
  if: 'flowforge.if',
  switch: 'flowforge.switch',
  filter: 'flowforge.filter',
  merge: 'flowforge.merge',
  noop: 'flowforge.noOp',
  code: 'flowforge.code',
  stop: 'flowforge.stopAndError',
  loop: 'flowforge.splitInBatches',
  limit: 'flowforge.limit',
  sort: 'flowforge.sort',
  sticky: 'flowforge.stickyNote',
};

export function wf(nodes: NodeSpec[], edges: EdgeSpec[], extra: Partial<WorkflowData> = {}): WorkflowData {
  const connections: Connections = {};
  for (const [from, to, output = 0, input = 0] of edges) {
    const main = ((connections[from] ??= {}).main ??= []);
    while (main.length <= output) main.push([]);
    main[output]!.push({ node: to, type: 'main', index: input });
  }
  return {
    name: 'Test workflow',
    nodes: nodes.map(([name, type, parameters = {}, more = {}], i) => ({
      id: String(i + 1),
      name,
      type: TYPE_ALIASES[type] ?? type,
      typeVersion: 1,
      position: [i * 200, 0],
      parameters,
      ...more,
    })),
    connections,
    ...extra,
  };
}

let nextId = 1;

export interface TestRun extends RunResult {
  /** Node names in the order they started. */
  order: string[];
  /** edge.data events as "from[output]->to[input]:count". */
  edges: string[];
}

export async function run(workflow: WorkflowData, req: Partial<RunRequest> = {}, runnerDefaults = {}, extras: RunnerExtras = {}): Promise<TestRun> {
  const runner = await makeRunner(runnerDefaults, extras);
  const order: string[] = [];
  const edges: string[] = [];
  const result = await runner.run({
    workflow,
    executionId: `t${nextId++}`,
    mode: 'manual',
    hooks: {
      nodeStarted: (name) => order.push(name),
      edgeData: (from, to, count) => edges.push(`${from.node}[${from.output}]->${to.node}[${to.input}]:${count}`),
    },
    ...req,
  });
  return { ...result, order, edges };
}

/** JSON of the items on `output` of the last run (or run `runIndex`) of `node`. */
export function out(result: { runData: RunData }, node: string, output = 0, runIndex?: number): JsonObject[] {
  const runs = result.runData[node];
  if (!runs?.length) return [];
  const runItems = runs[runIndex ?? runs.length - 1]!.data.main[output] ?? [];
  return runItems.map((i: Item) => i.json);
}

export const emit = (items: JsonObject[]): JsonObject => ({ items });
