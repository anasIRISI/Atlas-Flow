import { create } from 'zustand';
import { buildTimeline, type ExecutionDetail, type RunData, type TimelineStep } from '@flowforge/shared';
import { edgeKey, listEdges } from '../graph';
import { editor, useEditor, type ExecutionUi, type NodeLive } from '../store';

/** Client-side state of the time-travel debugger. Nothing here is ever written to the stored execution. */
interface ReplayState {
  active: boolean;
  detail: ExecutionDetail | null;
  steps: TimelineStep[];
  step: number;
  playing: boolean;
  speed: number;
}

export const useReplay = create<ReplayState>(() => ({ active: false, detail: null, steps: [], step: 0, playing: false, speed: 1 }));
const set = useReplay.setState;

/** What the canvas shows after step `k`: only runs that had happened by then. */
export function replayView(detail: ExecutionDetail, steps: TimelineStep[], k: number): { execution: ExecutionUi; runData: RunData } {
  const step = steps[k];
  const prev = k > 0 ? steps[k - 1] : undefined;
  const nodes: Record<string, NodeLive> = {};
  const runData: RunData = {};
  if (step) {
    for (const [name, st] of Object.entries(step.nodes)) {
      const runs = (detail.runData[name] ?? []).slice(0, st.runs);
      if (runs.length) runData[name] = runs;
      const last = runs[runs.length - 1];
      nodes[name] = {
        status: st.status === 'waiting' ? 'waiting' : st.status,
        itemCount: st.items,
        runs: st.runs,
        executionTime: last?.executionTime,
        error: last?.error,
      };
    }
  }
  const known = useEditor.getState().connections;
  const edges: ExecutionUi['edges'] = {};
  const live = new Set(listEdges(known).map(edgeKey));
  for (const [key, count] of Object.entries(step?.edges ?? {})) {
    if (!live.has(key)) continue;
    edges[key] = { count, key: prev?.edges[key] === count ? 0 : (step?.index ?? 0) + 1 };
  }
  const atEnd = k >= steps.length - 1;
  const log = steps.slice(0, k + 1).map((s) => {
    const run = detail.runData[s.node]?.[s.runIndex];
    return {
      node: s.node,
      runIndex: s.runIndex,
      status: s.status === 'waiting' ? ('success' as const) : s.status,
      executionTime: run?.executionTime ?? 0,
      itemCounts: run?.data.main.map((l) => l.length) ?? [],
      error: run?.error,
    };
  });
  return {
    runData,
    execution: {
      id: detail.id,
      status: atEnd ? detail.status : 'success',
      lastSeq: 0,
      startedAt: detail.startedAt ? Date.parse(detail.startedAt) : undefined,
      finishedAt: undefined,
      error: atEnd ? detail.error : null,
      nodes,
      edges,
      log,
    },
  };
}

export function showStep(k: number) {
  const { detail, steps } = useReplay.getState();
  if (!detail || steps.length === 0) return;
  const i = Math.max(0, Math.min(steps.length - 1, k));
  const view = replayView(detail, steps, i);
  const node = useEditor.getState().nodes.find((n) => n.name === steps[i]!.node);
  set({ step: i });
  useEditor.setState({ execution: view.execution, runData: view.runData, lastExecutionId: detail.id, ...(node ? { selected: [node.id] } : {}) });
}

export function startReplay(detail: ExecutionDetail) {
  const steps = buildTimeline(detail);
  set({ active: true, detail, steps, step: 0, playing: false });
  showStep(0);
}

/** Leave replay. `restore` puts the finished execution back on the canvas (the normal editor view). */
export function stopReplay(restore = true) {
  const { detail, active } = useReplay.getState();
  set({ active: false, detail: null, steps: [], step: 0, playing: false });
  if (active && detail && restore) {
    const names = new Set(useEditor.getState().nodes.map((n) => n.name));
    editor.finishFromDetail({
      ...detail,
      runData: Object.fromEntries(Object.entries(detail.runData).filter(([n]) => names.has(n))),
      events: detail.events.filter((ev) => names.has(ev.node)),
    });
  }
}

export const setPlaying = (playing: boolean) => {
  const { step, steps } = useReplay.getState();
  if (playing && step >= steps.length - 1) showStep(0);
  set({ playing });
};
export const setSpeed = (speed: number) => set({ speed });
