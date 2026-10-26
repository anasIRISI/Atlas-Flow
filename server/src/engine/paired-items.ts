import type { Item, PairedItem, RunData, TaskSource } from '@flowforge/shared';
import { ExpressionError } from './errors.js';

const MAX_DEPTH = 1000;

function asList(paired: Item['pairedItem']): PairedItem[] | undefined {
  if (paired === undefined) return undefined;
  return Array.isArray(paired) ? paired : [paired];
}

/**
 * Follows `pairedItem` links backwards from an item until it reaches `target`.
 * `item` is an output item of `fromNode` (run `fromRun`). Returns every item of `target` it derives from.
 */
function walk(runData: RunData, target: string, item: Item, fromNode: string, fromRun: number, depth: number): Item[] {
  if (fromNode === target) return [item];
  if (depth > MAX_DEPTH) return [];
  const run = runData[fromNode]?.[fromRun];
  if (!run) return [];
  let links = asList(item.pairedItem);
  if (!links) {
    // A node with a single input item: every output item comes from it.
    const total = run.source.reduce((n, s) => n + (s ? (sourceItems(runData, s)?.length ?? 0) : 0), 0);
    if (total !== 1) {
      throw new ExpressionError(`Can't get data for expression: paired item information is missing at node "${fromNode}"`, {
        hint: `FlowForge cannot tell which "${target}" item this one comes from. Use $('${target}').first(), .last() or .all() instead.`,
      });
    }
    links = [{ item: 0, input: run.source.findIndex((s) => s) }];
  }
  const found: Item[] = [];
  for (const link of links) {
    const source = run.source[link.input ?? 0];
    if (!source) continue;
    const previous = sourceItems(runData, source)?.[link.item];
    if (!previous) continue;
    found.push(...walk(runData, target, previous, source.previousNode, source.previousNodeRun, depth + 1));
  }
  return found;
}

function sourceItems(runData: RunData, source: TaskSource): Item[] | undefined {
  return runData[source.previousNode]?.[source.previousNodeRun]?.data.main[source.previousNodeOutput];
}

/**
 * The item of `target` that the current node's input item `itemIndex` derives from.
 * `inputs`/`sources` describe the current node's input (input 0 is used).
 */
export function resolvePairedItem(
  runData: RunData,
  target: string,
  inputs: Item[][],
  sources: (TaskSource | null)[],
  itemIndex: number,
): Item {
  if (!runData[target]?.length) {
    throw new ExpressionError(`Node "${target}" hasn't been executed yet`, {
      hint: `Execute the previous nodes first, or check that "${target}" is connected before this node.`,
    });
  }
  const item = inputs[0]?.[itemIndex];
  const source = sources[0];
  if (!item || !source) {
    throw new ExpressionError(`No input item ${itemIndex} to trace back to "${target}"`, {
      hint: `Use $('${target}').first() or .all() instead.`,
    });
  }
  const matches = walk(runData, target, item, source.previousNode, source.previousNodeRun, 0);
  const unique = [...new Set(matches)];
  if (unique.length === 0) {
    throw new ExpressionError(`Can't find the item of "${target}" that item ${itemIndex} comes from`, {
      hint: `"${target}" is not on the path that led to this node. Use $('${target}').first() or .all() instead.`,
    });
  }
  if (unique.length > 1) {
    throw new ExpressionError(`Multiple items of "${target}" match item ${itemIndex}`, {
      hint: `This item was built from several "${target}" items. Use $('${target}').first(), .last() or .all().`,
    });
  }
  return unique[0]!;
}
