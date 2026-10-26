import type { Item, JsonObject } from '@flowforge/shared';
import { getCodeSandbox, type SandboxError } from '../../engine/code/sandbox.js';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode, type ExecuteContext } from '../../engine/types.js';

const DEFAULT_ALL = `// Loop over input items and add a new field called 'myNewField' to the JSON of each one
for (const item of $input.all()) {
  item.json.myNewField = 1;
}

return $input.all();`;

const DEFAULT_EACH = `// Add a new field called 'myNewField' to the JSON of the item
$input.item.json.myNewField = 1;

return $input.item;`;

/** Limits can be tuned with environment variables (seconds / megabytes). */
export const codeLimits = {
  timeoutMs: Number(process.env.FLOWFORGE_CODE_TIMEOUT_SECONDS ?? 10) * 1000,
  memoryLimitBytes: Number(process.env.FLOWFORGE_CODE_MEMORY_MB ?? 128) * 1024 * 1024,
};

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Node names referenced as $('Name') or $node["Name"] in the code. */
function referencedNodes(code: string): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(/\$\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\)/g)) names.add(m[2]!);
  for (const m of code.matchAll(/\$node\[\s*(['"`])((?:\\.|(?!\1).)*)\1\s*\]/g)) names.add(m[2]!);
  return [...names];
}

const publicItem = (item: Item) => (item.binary ? { json: item.json, binary: item.binary } : { json: item.json });

function prelude(data: unknown): string {
  return `"use strict";
const __ffData = ${JSON.stringify(data)};
const __ffLogs = [];
let __ffItemIndex;
const __ffFormat = (v) => { if (typeof v === 'string') return v; try { return JSON.stringify(v); } catch (e) { return String(v); } };
const console = { log: (...a) => { if (__ffLogs.length < 200) __ffLogs.push(a.map(__ffFormat).join(' ')); } };
console.info = console.log; console.warn = console.log; console.error = console.log; console.debug = console.log;
const __ffNeedsItem = (what) => { throw new Error(what + " is only available in 'Run Once for Each Item' mode. Use .first() or .all() instead."); };
const $input = {
  all: () => __ffData.items,
  first: () => __ffData.items[0],
  last: () => __ffData.items[__ffData.items.length - 1],
  get item() { return __ffItemIndex === undefined ? __ffNeedsItem('$input.item') : __ffData.items[__ffItemIndex]; },
  params: __ffData.params,
};
const items = __ffData.items;
const $ = (name) => {
  const node = __ffData.nodes[name];
  if (!node) throw new Error('Node "' + name + '" has not been executed (or does not exist)');
  return {
    all: () => node.items,
    first: () => node.items[0],
    last: () => node.items[node.items.length - 1],
    isExecuted: true,
    get item() {
      if (__ffItemIndex === undefined) return __ffNeedsItem("$('" + name + "').item");
      const p = node.paired[__ffItemIndex];
      if (!p || p.error) throw new Error(p ? p.error : 'No matching item');
      return p.item;
    },
  };
};
const $node = new Proxy({}, { get: (_t, name) => ({ get json() { const n = $(String(name)); return (n.all()[__ffItemIndex || 0] || n.first() || {}).json; } }) });
const $workflow = __ffData.workflow;
const $execution = __ffData.execution;
const $vars = __ffData.vars;
const $env = __ffData.env === null ? new Proxy({}, { get: () => { throw new Error('Access to $env is disabled'); } }) : __ffData.env;
`;
}

function buildSource(code: string, mode: string, data: unknown): { source: string; lineOffset: number } {
  const head = prelude(data);
  const wrapperStart =
    mode === 'runOnceForEachItem'
      ? `const __ffRunItem = async function ($json, $binary, $itemIndex, item) {\n`
      : `const __ffRunAll = async function () {\n`;
  const before = head + wrapperStart;
  const tail =
    mode === 'runOnceForEachItem'
      ? `\n};
(async () => {
  const out = [];
  for (let i = 0; i < __ffData.items.length; i++) {
    __ffItemIndex = i;
    const it = __ffData.items[i];
    try {
      const r = await __ffRunItem(it.json, it.binary || {}, i, it);
      out.push({ ok: r === undefined ? null : r });
    } catch (e) {
      // Per-item errors are reported back so the node's "On Error" setting applies item by item.
      out.push({ err: { name: String((e && e.name) || 'Error'), message: String((e && e.message) || e), stack: String((e && e.stack) || '') } });
    }
  }
  return JSON.stringify({ result: out, logs: __ffLogs });
})()`
      : `\n};
__ffRunAll().then((r) => JSON.stringify({ result: r === undefined ? null : r, undef: r === undefined, logs: __ffLogs }))`;
  return { source: before + code + tail, lineOffset: before.split('\n').length - 1 };
}

function toItem(value: unknown, index: number, what: string): Item {
  if (isObject(value) && isObject(value.json)) {
    const item: Item = { json: value.json };
    if (isObject(value.binary)) item.binary = value.binary as Item['binary'];
    if (value.pairedItem !== undefined) item.pairedItem = value.pairedItem as Item['pairedItem'];
    return item;
  }
  if (isObject(value)) return { json: value };
  throw new NodeOperationError(`${what} ${index} is not an object (got ${value === null ? 'null' : typeof value})`, {
    hint: 'Return objects like { json: { … } } or plain objects like { name: "Ada" }.',
  });
}

function toNodeError(err: SandboxError | Error, lineOffset: number): NodeOperationError {
  const sandboxError = err as SandboxError;
  if (!('stack' in sandboxError) || err instanceof Error) {
    return err instanceof NodeOperationError ? err : new NodeOperationError(err.message);
  }
  if (sandboxError.name === 'InternalError' && /interrupted/.test(sandboxError.message)) {
    return new NodeOperationError(`Code took longer than ${codeLimits.timeoutMs / 1000} s and was stopped`, {
      hint: 'Check for an endless loop.',
    });
  }
  if (/out of memory/i.test(sandboxError.message)) {
    return new NodeOperationError(`Code used more than ${codeLimits.memoryLimitBytes / 1024 / 1024} MB of memory and was stopped`);
  }
  const lineMatch = /code\.js:(\d+)/.exec(sandboxError.stack);
  const line = lineMatch ? Number(lineMatch[1]) - lineOffset : undefined;
  const where = line && line > 0 ? ` [line ${line}]` : '';
  // "TypeError: …" is informative; a plain "Error: " prefix is just noise.
  const prefix = sandboxError.name && sandboxError.name !== 'Error' ? `${sandboxError.name}: ` : '';
  return new NodeOperationError(`${prefix}${sandboxError.message}${where}`, {
    hint: sandboxError.name === 'ReferenceError' ? 'Note: require(), process and fetch are not available in the Code node.' : undefined,
  });
}

async function runCode(ctx: ExecuteContext): Promise<Item[]> {
  const mode = ctx.getNodeParameter<string>('mode', 0);
  const code = String(ctx.getRawParameter(mode === 'runOnceForEachItem' ? 'jsCodeEachItem' : 'jsCode') ?? '');
  const input = ctx.getInputData();
  const nodes: Record<string, { items: unknown[]; paired: unknown[] }> = {};
  for (const name of referencedNodes(code)) {
    const output = ctx.getNodeOutput(name);
    if (!output) continue;
    nodes[name] = {
      items: output.map(publicItem),
      paired: input.map((_, i) => {
        try {
          return { item: publicItem(ctx.getPairedItem(name, i)) };
        } catch (err) {
          return { error: (err as Error).message };
        }
      }),
    };
  }
  const data = {
    items: input.map(publicItem),
    nodes,
    params: ctx.node.parameters,
    workflow: { id: ctx.workflow.id ?? null, name: ctx.workflow.name, active: Boolean(ctx.workflow.active) },
    execution: { id: ctx.executionId, mode: ctx.mode === 'manual' ? 'test' : 'production' },
    vars: ctx.getVariables(),
    env: ctx.getEnv(),
  };
  const { source, lineOffset } = buildSource(code, mode, data);

  let raw: string;
  try {
    raw = await getCodeSandbox().run({ source, ...codeLimits, signal: ctx.signal });
  } catch (err) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    throw toNodeError(err as SandboxError, lineOffset);
  }
  const { result, undef, logs } = JSON.parse(raw) as { result: unknown; undef?: boolean; logs: string[] };
  logs.forEach((line) => ctx.addLog(line));

  if (mode === 'runOnceForEachItem') {
    const entries = result as Array<{ ok?: unknown; err?: SandboxError }>;
    return ctx.forEachItem((_item, i) => {
      const entry = entries[i]!;
      if (entry.err) throw toNodeError(entry.err, lineOffset);
      const value = entry.ok;
      if (value === null || value === undefined) {
        throw new NodeOperationError(`The code returned nothing for item ${i}`, {
          itemIndex: i,
          hint: 'End your code with "return $input.item;" or return an object.',
        });
      }
      if (Array.isArray(value)) throw new NodeOperationError(`Return one object per item, not a list (item ${i})`, { itemIndex: i });
      return { ...toItem(value, i, 'Result of item'), pairedItem: { item: i } };
    });
  }
  if (undef) {
    throw new NodeOperationError('The code did not return anything', { hint: 'End your code with "return $input.all();" or return a list of items.' });
  }
  const list = Array.isArray(result) ? result : [result];
  return list.map((value, i) => toItem(value, i, 'Item'));
}

export default defineNode({
  description: {
    type: 'flowforge.code',
    displayName: 'Code',
    description: 'Runs your own JavaScript in a secure sandbox.',
    icon: 'lucide:code',
    group: 'transform',
    version: 1,
    defaults: { name: 'Code', color: '#ff9922' },
    subtitle: '{{mode}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['javascript', 'js', 'script', 'function', 'custom'],
  },
  properties: [
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'options',
      default: 'runOnceForAllItems',
      options: [
        { name: 'Run Once for All Items', value: 'runOnceForAllItems', description: 'Your code runs once and gets every item' },
        { name: 'Run Once for Each Item', value: 'runOnceForEachItem', description: 'Your code runs for each item ($json = current item)' },
      ],
    },
    {
      name: 'jsCode',
      displayName: 'JavaScript',
      type: 'code',
      default: DEFAULT_ALL,
      noDataExpression: true,
      typeOptions: { language: 'javascript', rows: 12 },
      displayOptions: { show: { mode: ['runOnceForAllItems'] } },
    },
    {
      name: 'jsCodeEachItem',
      displayName: 'JavaScript',
      type: 'code',
      default: DEFAULT_EACH,
      noDataExpression: true,
      typeOptions: { language: 'javascript', rows: 12 },
      displayOptions: { show: { mode: ['runOnceForEachItem'] } },
    },
    {
      name: 'notice',
      displayName: 'Available: $input, $json (each item), $("Node"), console.log(). Not available: require, fetch, process.',
      type: 'notice',
      default: '',
    },
  ],
  async execute(ctx) {
    return [await runCode(ctx)];
  },
});
