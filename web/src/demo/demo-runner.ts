// Runs the demo script in the editor: build -> QR -> wait/simulate -> run -> results. Every step has a fallback.
import type { BuildWorkflowResponse, ExecutionDetail, ExecutionPage } from '@flowforge/shared';
import { api, errorMessage } from '../lib/api';
import { toast } from '../lib/toast';
import { completeExecution, save } from '../editor/actions';
import { drawWorkflow } from '../editor/builder';
import { useEditor } from '../editor/store';
import { fetchExecution } from '../lib/workflows-api';
import { buildToast, shouldSimulate } from './demo-script';
import { useDemo } from './demo-store';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done);
  });

async function waitFor<T>(check: () => T | undefined | false | null, timeoutMs: number, signal?: AbortSignal, everyMs = 100): Promise<T | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !signal?.aborted) {
    const value = check();
    if (value) return value;
    await sleep(everyMs, signal);
  }
  return undefined;
}

async function executionIds(workflowId: string): Promise<string[]> {
  const page = await api<ExecutionPage>(`/executions?workflowId=${encodeURIComponent(workflowId)}&limit=10`);
  return page.items.map((e) => e.id);
}

export async function runDemoScript(fit: () => void): Promise<void> {
  const myRun = useDemo.getState().runId;
  const alive = () => useDemo.getState().runId === myRun && useDemo.getState().state.phase === 'running';
  const dispatch = useDemo.getState().dispatch;
  const build = useDemo.getState().build;
  if (!build) return;

  /** Runs one step with its own abort signal ("Skip step" / "Stop demo" abort it). */
  const step = async (fn: (signal: AbortSignal) => Promise<void>) => {
    if (!alive()) return false;
    const controller = new AbortController();
    useDemo.setState({ stepAbort: controller });
    try {
      await fn(controller.signal);
    } catch (err) {
      toast.error('Demo step failed', errorMessage(err));
    }
    if (!alive()) return false;
    dispatch({ type: 'next' });
    return true;
  };

  // 1. Build: draw the workflow with the AI builder animation.
  if (
    !(await step(async () => {
      const ready = await waitFor(() => useEditor.getState().workflowId === build.workflowId, 15_000);
      if (!ready) throw new Error('The editor did not open the demo workflow');
      toast.success(buildToast(build.source), build.warnings[0]);
      const result: BuildWorkflowResponse = {
        workflow: build.workflow,
        source: build.source === 'gemini' ? 'ai' : 'offline',
        label: build.label,
        notes: [],
        missingCredentials: [],
        order: build.workflow.nodes.map((n) => n.name),
      };
      await drawWorkflow(result, fit);
      await sleep(900);
      await save();
    }))
  )
    return;

  // 2. QR code of the form (test URL). If listening fails, the submission is simulated directly.
  let listenFailed = false;
  let testUrl: string | undefined;
  let baseline: string[] = [];
  try {
    baseline = await executionIds(build.workflowId);
    const listen = await api<{ formUrl: string; testUrl: string }>('/demo/listen', { method: 'POST', body: { workflowId: build.workflowId } });
    testUrl = listen.testUrl;
    useDemo.setState({ formUrl: listen.formUrl });
  } catch (err) {
    listenFailed = true;
    dispatch({ type: 'fallback', note: 'The form could not listen: the submission is simulated' });
    toast.info('Could not open the form', errorMessage(err));
  }
  if (!(await step((signal) => sleep(listenFailed ? 300 : 4500, signal)))) return;

  // 3. Wait for a real submission; after the timeout (or "Skip step") simulate one.
  let executionId: string | undefined;
  let error: string | undefined;
  if (
    !(await step(async (signal) => {
      const startedAt = Date.now();
      while (!signal.aborted && !listenFailed && !shouldSimulate(Date.now() - startedAt, useDemo.getState().waitMs)) {
        const fresh = (await executionIds(build.workflowId).catch(() => [])).find((id) => !baseline.includes(id));
        if (fresh) {
          executionId = fresh;
          return;
        }
        await sleep(700, signal);
      }
      toast.info('Simulating a submission', 'Nobody filled in the form, so Demo Mode submits sample answers.');
      dispatch({ type: 'fallback', note: 'Simulating a submission', simulatedSubmission: true });
      try {
        executionId = (await api<{ executionId: string }>('/demo/simulate-submission', { method: 'POST', body: { workflowId: build.workflowId, ...(testUrl ? { testUrl } : {}) } })).executionId;
      } catch (err) {
        error = errorMessage(err);
      }
    }))
  )
    return;
  useDemo.setState({ formUrl: null, executionId: executionId ?? null });

  // 4. Run: the editor shows it live over WebSocket; here we only wait for the end.
  let detail: ExecutionDetail | undefined;
  if (
    !(await step(async (signal) => {
      if (!executionId) return;
      const id = executionId;
      const started = Date.now();
      while (!signal.aborted && Date.now() - started < 90_000) {
        const current = await fetchExecution(id).catch(() => undefined);
        if (current && !['queued', 'running'].includes(current.status)) {
          detail = current;
          break;
        }
        await sleep(600, signal);
      }
      await completeExecution(id);
      detail ??= await fetchExecution(id).catch(() => undefined);
      await sleep(800);
    }))
  )
    return;

  // 5. Results card (the overlay renders it from the store).
  if (!detail && executionId) detail = await fetchExecution(executionId).catch(() => undefined);
  if (error) dispatch({ type: 'fallback', note: `The submission could not be simulated: ${error}` });
  useDemo.setState({ detail: detail ?? null });
  useDemo.setState({ stepAbort: null });
}
