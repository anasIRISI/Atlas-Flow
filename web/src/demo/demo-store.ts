import { create } from 'zustand';
import type { BuildWorkflowResponse, ExecutionDetail } from '@flowforge/shared';
import { api, errorMessage } from '../lib/api';
import { toast } from '../lib/toast';
import { DEFAULT_WAIT_MS, demoReducer, initialDemo, parseWaitMs, type DemoAction, type DemoState } from './demo-script';

export type DemoSource = 'gemini' | 'offline' | 'showcase';

export interface DemoBuild {
  workflowId: string;
  workflow: BuildWorkflowResponse['workflow'];
  source: DemoSource;
  label: string;
  warnings: string[];
}

interface DemoStore {
  state: DemoState;
  /** Increments for every demo: a stale script stops when it sees another id. */
  runId: number;
  build: DemoBuild | null;
  waitMs: number;
  formUrl: string | null;
  executionId: string | null;
  detail: ExecutionDetail | null;
  /** Aborted by "Skip step" and "Stop demo". */
  stepAbort: AbortController | null;
  starting: boolean;
  dispatch(action: DemoAction): void;
  set(patch: Partial<Omit<DemoStore, 'dispatch'>>): void;
}

export const useDemo = create<DemoStore>((set) => ({
  state: initialDemo(),
  runId: 0,
  build: null,
  waitMs: DEFAULT_WAIT_MS,
  formUrl: null,
  executionId: null,
  detail: null,
  stepAbort: null,
  starting: false,
  dispatch: (action) => set((s) => ({ state: demoReducer(s.state, action) })),
  set: (patch) => set(patch),
}));

const BUILD_TIMEOUT_MS = 20_000;

/** Builds the demo workflow on the server; Gemini too slow or failing => the showcase template. */
async function buildDemoWorkflow(): Promise<DemoBuild> {
  const call = (body: object, ms?: number) => {
    const request = api<DemoBuild>('/demo/build', { method: 'POST', body });
    if (!ms) return request;
    return Promise.race([request, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The AI builder took too long')), ms))]);
  };
  try {
    return await call({}, BUILD_TIMEOUT_MS);
  } catch {
    return await call({ showcase: true });
  }
}

/** "Demo Mode" button: builds the workflow, then opens the editor where the overlay runs the rest of the script. */
export async function startDemo(navigate: (to: string) => void): Promise<void> {
  const current = useDemo.getState();
  if (current.starting) return;
  if (current.state.phase === 'running') stopDemo();
  useDemo.setState({ starting: true });
  const waitMs = parseWaitMs(new URLSearchParams(window.location.search).get('demoWait'));
  toast.info('Demo Mode', 'Building the demo workflow...');
  try {
    const build = await buildDemoWorkflow();
    const runId = useDemo.getState().runId + 1;
    useDemo.setState({ runId, build, waitMs, formUrl: null, executionId: null, detail: null, stepAbort: null });
    useDemo.getState().dispatch({ type: 'start' });
    if (build.source === 'showcase') useDemo.getState().dispatch({ type: 'fallback', note: build.label });
    navigate(`/workflow/${build.workflowId}?demo=1`);
  } catch (err) {
    toast.error('Demo Mode could not start', errorMessage(err));
  } finally {
    useDemo.setState({ starting: false });
  }
}

export function skipDemoStep(): void {
  useDemo.getState().stepAbort?.abort();
}

export function stopDemo(): void {
  const s = useDemo.getState();
  s.stepAbort?.abort();
  if (s.state.phase === 'running') s.dispatch({ type: 'stop' });
  useDemo.setState({ runId: s.runId + 1, formUrl: null, stepAbort: null });
  useDemo.setState({ state: initialDemo() });
}
