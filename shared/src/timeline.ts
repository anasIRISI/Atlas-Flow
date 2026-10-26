import type { ExecutionDetail, Item, NodeRun, NodeRunStatus } from './workflow.js';

/** Data the time-travel debugger needs (a stored execution). */
export type TimelineSource = Pick<ExecutionDetail, 'runData' | 'events' | 'status' | 'waitingNode'> & Partial<Pick<ExecutionDetail, 'startedAt'>>;

export type StepStatus = NodeRunStatus | 'waiting';

export interface TimelineNodeState {
  status: StepStatus;
  runs: number;
  items: number;
}

export interface TimelineStep {
  index: number;
  node: string;
  runIndex: number;
  status: StepStatus;
  startedAt: number;
  durationMs: number | null;
  /** State of every node AFTER this step. */
  nodes: Record<string, TimelineNodeState>;
  /** Edge keys (same format as web/src/editor/graph.ts `edgeKey`) that carried data up to this step → item count. */
  edges: Record<string, number>;
}

/** Same format as `edgeKey()` in web/src/editor/graph.ts (kept in sync by web/tests/timeline-edge-key.test.ts). */
export const timelineEdgeKey = (source: string, output: number, target: string, input: number) =>
  `${encodeURIComponent(source)}:${output}->${encodeURIComponent(target)}:${input}`;

const countItems = (run: NodeRun) => run.data.main.reduce((a, list) => a + list.length, 0);

interface Raw {
  node: string;
  runIndex: number;
}

/** Order of the finished runs: recorded events when present, otherwise reconstructed from start times. */
function finishedRuns(d: TimelineSource): Raw[] {
  const seen = new Set<string>();
  const out: Raw[] = [];
  for (const ev of [...d.events].sort((a, b) => a.seq - b.seq)) {
    if (ev.type !== 'node.finished') continue;
    const key = `${ev.node}\u0000${ev.runIndex}`;
    if (seen.has(key) || !d.runData[ev.node]?.[ev.runIndex]) continue; // node missing from runData: skip
    seen.add(key);
    out.push({ node: ev.node, runIndex: ev.runIndex });
  }
  // Runs that have data but no event (old executions): add them by start time.
  const missing: Array<Raw & { t: number }> = [];
  for (const [node, runs] of Object.entries(d.runData)) {
    runs.forEach((run, runIndex) => {
      if (!seen.has(`${node}\u0000${runIndex}`)) missing.push({ node, runIndex, t: run.startTime });
    });
  }
  if (out.length === 0) missing.sort((a, b) => a.t - b.t || a.runIndex - b.runIndex);
  return out.length === 0 ? missing : [...out, ...missing.sort((a, b) => a.t - b.t)];
}

export function buildTimeline(detail: TimelineSource): TimelineStep[] {
  const steps: TimelineStep[] = [];
  const nodes: Record<string, TimelineNodeState> = {};
  const edges: Record<string, number> = {};
  const snapshot = () => ({ nodes: Object.fromEntries(Object.entries(nodes).map(([k, v]) => [k, { ...v }])), edges: { ...edges } });

  for (const { node, runIndex } of finishedRuns(detail)) {
    const run = detail.runData[node]![runIndex]!;
    nodes[node] = { status: run.status, runs: runIndex + 1, items: countItems(run) };
    (run.source ?? []).forEach((src, input) => {
      if (!src) return;
      const parent = detail.runData[src.previousNode]?.[src.previousNodeRun];
      const count = parent?.data.main[src.previousNodeOutput]?.length ?? 0;
      if (count > 0) edges[timelineEdgeKey(src.previousNode, src.previousNodeOutput, node, input)] = count;
    });
    steps.push({ index: steps.length, node, runIndex, status: run.status, startedAt: run.startTime, durationMs: run.executionTime, ...snapshot() });
  }

  if (detail.status === 'waiting' && detail.waitingNode) {
    const node = detail.waitingNode;
    const runIndex = detail.runData[node]?.length ?? 0;
    nodes[node] = { status: 'waiting', runs: runIndex + 1, items: 0 };
    const last = steps[steps.length - 1];
    steps.push({ index: steps.length, node, runIndex, status: 'waiting', startedAt: last ? last.startedAt + (last.durationMs ?? 0) : 0, durationMs: null, ...snapshot() });
  }
  return steps;
}

export function stepInput(detail: Pick<TimelineSource, 'runData'>, step: Pick<TimelineStep, 'node' | 'runIndex'>): Item[][] {
  const run = detail.runData[step.node]?.[step.runIndex];
  if (!run) return [];
  const sources = run.source ?? [];
  if (sources.length === 0) return [];
  return sources.map((src) => {
    if (!src) return [];
    return detail.runData[src.previousNode]?.[src.previousNodeRun]?.data.main[src.previousNodeOutput] ?? [];
  });
}

export function stepOutput(detail: Pick<TimelineSource, 'runData'>, step: Pick<TimelineStep, 'node' | 'runIndex'>): Item[][] {
  return detail.runData[step.node]?.[step.runIndex]?.data.main ?? [];
}
