import { createHash, getHashes } from 'node:crypto';
import jmespath from 'jmespath';
import type { Item } from '@flowforge/shared';
import { ExpressionError, FlowError } from '../errors.js';
import { resolvePairedItem } from '../paired-items.js';
import type { Bridge } from './realm.js';
import type { ExpressionScope } from './scope.js';

export interface EvalState {
  scope: ExpressionScope;
  itemIndex: number;
  /**
   * First error reported through the bridge in this evaluation. Node calls the getter of a sandbox global
   * twice when it throws, and the second call only sees a re-wrapped copy ("Error: …", no hint).
   */
  firstError?: { message: string; hint?: string };
}

const HASHES = new Set(getHashes());

/** What expressions get for an item: its JSON and binary metadata (lineage stays internal). */
function publicItem(item: Item | undefined): { json: unknown; binary?: unknown } | undefined {
  if (!item) return undefined;
  return item.binary ? { json: item.json, binary: item.binary } : { json: item.json };
}

function requireNodeOutput(scope: ExpressionScope, name: unknown, branch: unknown, run: unknown): Item[] {
  if (typeof name !== 'string') throw new ExpressionError('A node name is required');
  if (!scope.workflow.nodes.some((n) => n.name === name)) {
    throw new ExpressionError(`Referenced node "${name}" doesn't exist`, {
      hint: 'Check the spelling of the node name (it is case-sensitive). Renamed nodes must be updated in expressions.',
    });
  }
  const runs = scope.runData[name];
  if (!runs?.length) {
    throw new ExpressionError(`Node "${name}" hasn't been executed yet`, {
      hint: `Execute the previous nodes first, or check that "${name}" runs before this node.`,
    });
  }
  const runIndex = typeof run === 'number' ? run : runs.length - 1;
  const selected = runs[runIndex];
  if (!selected) throw new ExpressionError(`Node "${name}" has no run ${runIndex}`);
  return selected.data.main[typeof branch === 'number' ? branch : 0] ?? [];
}

function handle(op: string, args: unknown[], { scope, itemIndex }: EvalState): unknown {
  const inputIndex = typeof args[0] === 'number' ? args[0] : 0;
  switch (op) {
    case 'input.all':
      return (scope.inputs[inputIndex] ?? []).map(publicItem);
    case 'input.first':
      return publicItem(scope.inputs[inputIndex]?.[0]);
    case 'input.last': {
      const items = scope.inputs[inputIndex] ?? [];
      return publicItem(items[items.length - 1]);
    }
    case 'input.item': {
      const item = scope.inputs[0]?.[itemIndex];
      if (!item) throw new ExpressionError(`There is no input item ${itemIndex}`);
      return publicItem(item);
    }
    case 'input.params':
      return scope.workflow.nodes.find((n) => n.name === scope.nodeName)?.parameters ?? {};
    case 'node.all':
      return requireNodeOutput(scope, args[0], args[1], args[2]).map(publicItem);
    case 'node.first':
      return publicItem(requireNodeOutput(scope, args[0], args[1], args[2])[0]);
    case 'node.last': {
      const items = requireNodeOutput(scope, args[0], args[1], args[2]);
      return publicItem(items[items.length - 1]);
    }
    case 'node.item':
    case 'node.itemMatching': {
      requireNodeOutput(scope, args[0], 0, undefined);
      const index = op === 'node.item' ? itemIndex : Number(args[1]);
      return publicItem(resolvePairedItem(scope.runData, String(args[0]), scope.inputs, scope.sources, index));
    }
    case 'node.isExecuted':
      return Boolean(scope.runData[String(args[0])]?.length);
    case 'node.params': {
      const node = scope.workflow.nodes.find((n) => n.name === args[0]);
      if (!node) throw new ExpressionError(`Referenced node "${String(args[0])}" doesn't exist`);
      return node.parameters;
    }
    case 'node.runIndex':
      return (scope.runData[String(args[0])]?.length ?? 0) - 1;
    case 'legacy.json':
    case 'legacy.binary': {
      const items = requireNodeOutput(scope, args[0], 0, undefined);
      const item = items[itemIndex] ?? items[0];
      return op === 'legacy.json' ? (item?.json ?? {}) : (item?.binary ?? {});
    }
    case 'items':
      if (args[0] === undefined || args[0] === null) return (scope.inputs[0] ?? []).map(publicItem);
      return requireNodeOutput(scope, args[0], args[1], args[2]).map(publicItem);
    case 'prevNode': {
      const source = scope.sources[0];
      return source
        ? { name: source.previousNode, outputIndex: source.previousNodeOutput, runIndex: source.previousNodeRun }
        : undefined;
    }
    case 'workflow':
      return { id: scope.workflow.id ?? null, name: scope.workflow.name, active: Boolean(scope.workflow.active) };
    case 'execution':
      return {
        id: scope.executionId,
        mode: scope.mode === 'manual' ? 'test' : 'production',
        resumeUrl: scope.resumeUrl ?? '',
        resumeFormUrl: scope.resumeFormUrl ?? '',
      };
    case 'env':
      if (scope.env === null) {
        throw new ExpressionError('Access to $env is disabled', { hint: 'An administrator can allow it in Settings.' });
      }
      return scope.env;
    case 'vars':
      return scope.variables;
    case 'tz':
      return scope.timezone;
    case 'extra': {
      const name = String(args[0]);
      if (!scope.extra || !(name in scope.extra)) {
        throw new ExpressionError(`${name} is not available here`, {
          hint: 'It only exists in the pagination settings of the HTTP Request node, while the node runs.',
        });
      }
      return scope.extra[name];
    }
    case 'jmespath':
      if (typeof args[1] !== 'string') throw new ExpressionError('$jmespath(data, "query") needs a query string');
      return jmespath.search(args[0] as never, args[1]);
    case 'hash': {
      const algorithm = String(args[1]).toLowerCase();
      if (!HASHES.has(algorithm)) throw new ExpressionError(`Unknown hash algorithm "${algorithm}"`, { hint: 'Try md5, sha1, sha256 or sha512.' });
      return createHash(algorithm).update(String(args[0])).digest('hex');
    }
    case 'base64':
      return args[1] === 'decode'
        ? Buffer.from(String(args[0]), 'base64').toString('utf8')
        : Buffer.from(String(args[0]), 'utf8').toString('base64');
    default:
      throw new ExpressionError(`Unknown sandbox operation "${op}"`);
  }
}

/** Builds the host side of the sandbox bridge. Errors travel back as plain messages, never as host objects. */
export function createBridge(getState: () => EvalState | undefined): Bridge {
  return (op, argsJson) => {
    try {
      const state = getState();
      if (!state) throw new ExpressionError('No expression is being evaluated');
      const value = handle(op, JSON.parse(argsJson) as unknown[], state);
      return value === undefined ? '{"u":true}' : JSON.stringify({ v: value });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = err instanceof FlowError ? err.hint : undefined;
      const state = getState();
      if (state && !state.firstError) state.firstError = { message, hint };
      return JSON.stringify({ e: message, h: hint });
    }
  };
}
