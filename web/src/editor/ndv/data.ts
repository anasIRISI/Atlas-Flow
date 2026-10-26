import type { Connections, Item, NodeRun, RunData, TaskSource } from '@flowforge/shared';
import { listEdges } from '../graph';

export interface InputData {
  items: Item[];
  /** Where the items came from (for lineage in expression previews). */
  source: (TaskSource | null)[];
  fromNode?: string;
  fromOutput?: number;
}

/**
 * Input of a node: what it received in its last (or chosen) run, or — if it has not run yet —
 * the last output of the node connected to that input (or that node's pinned data).
 */
export function inputFor(
  nodeName: string,
  inputIndex: number,
  connections: Connections,
  runData: RunData | null,
  pinData: Record<string, Item[]>,
  runIndex?: number,
): InputData {
  const runs = runData?.[nodeName];
  if (runs?.length) {
    const run = runs[runIndex ?? runs.length - 1] ?? runs[runs.length - 1]!;
    const src = run.source[inputIndex];
    if (src) {
      return {
        items: runData?.[src.previousNode]?.[src.previousNodeRun]?.data.main[src.previousNodeOutput] ?? [],
        source: run.source,
        fromNode: src.previousNode,
        fromOutput: src.previousNodeOutput,
      };
    }
  }
  const parents = listEdges(connections).filter((e) => e.target === nodeName && e.input === inputIndex);
  for (const p of parents) {
    const parentRuns = runData?.[p.source];
    if (parentRuns?.length) {
      const items = parentRuns[parentRuns.length - 1]!.data.main[p.output] ?? [];
      const source: (TaskSource | null)[] = [];
      source[inputIndex] = { previousNode: p.source, previousNodeOutput: p.output, previousNodeRun: parentRuns.length - 1 };
      return { items, source, fromNode: p.source, fromOutput: p.output };
    }
    if (p.output === 0 && pinData[p.source]) return { items: pinData[p.source]!, source: [], fromNode: p.source, fromOutput: 0 };
  }
  return { items: [], source: [], fromNode: parents[0]?.source };
}

export function lastRun(runData: RunData | null, name: string): NodeRun | undefined {
  const runs = runData?.[name];
  return runs?.[runs.length - 1];
}

/** A sample JSON object per executed (or pinned) node, for autocomplete. */
export function nodeSamples(runData: RunData | null, pinData: Record<string, Item[]>): Record<string, Record<string, unknown> | undefined> {
  const out: Record<string, Record<string, unknown> | undefined> = {};
  for (const [name, items] of Object.entries(pinData)) out[name] = items[0]?.json;
  for (const name of Object.keys(runData ?? {})) out[name] = lastRun(runData, name)?.data.main.find((l) => l.length)?.[0]?.json;
  return out;
}
