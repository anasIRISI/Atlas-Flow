/** Time-travel scrubber shown at the bottom of the editor while replaying an execution — owner: W1. Contract: docs/phase8-contracts.md */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CircleAlert, History, Pause, Play, RotateCcw, SkipBack, SkipForward, X } from 'lucide-react';
import { stepInput, stepOutput, type ExecutionDetail } from '@flowforge/shared';
import { Button } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';
import { Spinner } from '../../components/ui/Spinner';
import { api, errorMessage } from '../../lib/api';
import { duration, plural } from '../../lib/format';
import { toast } from '../../lib/toast';
import { runWorkflow } from '../../lib/workflows-api';
import { DataView, hasBinary, savedView, saveView, ViewSwitch, type ViewMode } from '../ndv/DataView';
import { editor, isRunning, useEditor, workflowData } from '../store';
import { setPlaying, setSpeed, showStep, startReplay, stopReplay, useReplay } from './replay';

const SPEEDS = [0.5, 1, 2, 4];
const TICK: Record<string, string> = {
  success: 'bg-success',
  error: 'bg-danger',
  waiting: 'bg-warning',
  pinned: 'bg-[#c4a6ff]',
  reused: 'bg-subtle',
  disabled: 'bg-line-strong',
};

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable || !!el.closest?.('.cm-editor'));
};

export function TimeTravelBar() {
  const [search, setSearch] = useSearchParams();
  const wanted = search.get('replay') === '1' ? search.get('execution') : null;
  const { active, detail, steps, step, playing, speed } = useReplay();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const workflowId = useEditor((s) => s.workflowId);
  const editorNodes = useEditor((s) => s.nodes);

  const leave = (restore = true) => {
    stopReplay(restore);
    setError(null);
    setSearch(
      (p) => {
        p.delete('replay');
        return p;
      },
      { replace: true },
    );
  };

  // Load the execution when the URL asks for a replay.
  useEffect(() => {
    if (!wanted || !workflowId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<ExecutionDetail>(`/executions/${wanted}`)
      .then((d) => {
        if (cancelled) return;
        if (['queued', 'running'].includes(d.status)) throw new Error('This execution is still running. Open it again when it has finished.');
        startReplay(d);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [wanted, workflowId, attempt]);

  // Leaving the editor page ends the replay.
  useEffect(() => () => stopReplay(false), []);

  // Play.
  useEffect(() => {
    if (!active || !playing) return;
    const t = setTimeout(() => {
      const { step: k, steps: all } = useReplay.getState();
      if (k >= all.length - 1) setPlaying(false);
      else showStep(k + 1);
    }, 900 / speed);
    return () => clearTimeout(t);
  }, [active, playing, step, speed]);

  // A real run (or any other change to the execution shown) ends the replay: it must never be mixed with live data.
  useEffect(
    () =>
      useEditor.subscribe((s) => {
        const r = useReplay.getState();
        if (r.active && r.detail && (s.execution.id !== r.detail.id || isRunning(s.execution.status))) {
          useReplay.setState({ active: false, detail: null, steps: [], step: 0, playing: false });
        }
      }),
    [],
  );

  // Keyboard.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const r = useReplay.getState();
      if (e.key === 'ArrowRight') showStep(r.step + 1);
      else if (e.key === 'ArrowLeft') showStep(r.step - 1);
      else if (e.key === ' ' && !(e.target as HTMLElement | null)?.closest?.('button')) setPlaying(!r.playing);
      else if (e.key === 'Escape') leave();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = steps[step];
  const missing = useMemo(() => {
    if (!detail) return 0;
    const names = new Set(editorNodes.map((n) => n.name));
    return Object.keys(detail.runData).filter((n) => !names.has(n)).length;
  }, [detail, editorNodes]);

  if (!wanted && !active) return null;
  if (loading && !active) {
    return (
      <div className="flex items-center gap-2 border-t border-line bg-panel px-4 py-3 text-[12.5px] text-muted" data-testid="timetravel-loading">
        <Spinner size={14} /> Loading the recorded execution…
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex items-center gap-3 border-t border-line bg-panel px-4 py-3 text-[12.5px]" data-testid="timetravel-error">
        <CircleAlert size={15} className="text-danger" />
        <span className="min-w-0 flex-1 truncate">Could not load this execution: {error}</span>
        <Button size="sm" variant="secondary" onClick={() => setAttempt((a) => a + 1)}>
          Try again
        </Button>
        <Button size="sm" variant="ghost" onClick={() => leave(false)}>
          Close
        </Button>
      </div>
    );
  }
  if (!active || !detail) return null;
  if (steps.length === 0 || !current) {
    return (
      <div className="flex items-center gap-3 border-t border-line bg-panel px-4 py-3 text-[12.5px]" data-testid="timetravel-empty">
        <History size={15} className="text-subtle" />
        <span className="flex-1 text-muted">This execution recorded no steps to replay.</span>
        <Button size="sm" variant="ghost" onClick={() => leave()}>
          Close
        </Button>
      </div>
    );
  }

  const canRerun = !current.status.includes('waiting') && editorNodes.some((n) => n.name === current.node);
  const rerun = async () => {
    const node = current.node;
    const previousExecutionId = detail.id;
    stopReplay(true);
    setSearch((p) => (p.delete('replay'), p), { replace: true });
    editor.prepareRun();
    try {
      const { executionId } = await runWorkflow({ workflow: workflowData(), rerunFrom: node, previousExecutionId });
      const ex = useEditor.getState().execution;
      if (!ex.id) useEditor.setState({ execution: { ...ex, id: executionId, status: 'queued' } });
      toast.info(`Re-running from "${node}"`, 'Earlier nodes reuse the recorded data. This creates a new execution.');
    } catch (e) {
      editor.runFailedToStart({ name: 'Error', message: errorMessage(e) });
      toast.error('Could not re-run', errorMessage(e));
    }
  };

  const btn = 'grid size-8 place-items-center rounded-md text-muted hover:bg-panel-3 hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent';
  return (
    <div className="border-t border-accent/40 bg-panel animate-fade-in" data-testid="timetravel-bar" tabIndex={-1}>
      <StepPanel detail={detail} stepIndex={step} />
      {missing > 0 && (
        <div className="border-t border-line bg-warning/5 px-4 py-1 text-[12px] text-warning" data-testid="timetravel-changed">
          This workflow changed after the run: {plural(missing, 'node')} of the run {missing === 1 ? 'is' : 'are'} no longer on the canvas.
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
        <span className="flex items-center gap-1.5 rounded-md bg-accent-soft px-2 py-1 text-[11.5px] font-semibold text-accent-hover">
          <History size={13} /> Time travel
        </span>
        <button type="button" className={btn} title="Previous step (←)" aria-label="Previous step" disabled={step <= 0} onClick={() => showStep(step - 1)} data-testid="tt-prev">
          <SkipBack size={15} />
        </button>
        <button type="button" className={cn(btn, 'bg-panel-2 text-fg')} title="Play / pause (space)" aria-label={playing ? 'Pause' : 'Play'} onClick={() => setPlaying(!playing)} data-testid="tt-play">
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button type="button" className={btn} title="Next step (→)" aria-label="Next step" disabled={step >= steps.length - 1} onClick={() => showStep(step + 1)} data-testid="tt-next">
          <SkipForward size={15} />
        </button>
        <div className="flex min-w-[160px] flex-1 items-center gap-[3px]" role="group" aria-label="Steps" data-testid="tt-scrubber">
          {steps.map((s) => (
            <button
              key={s.index}
              type="button"
              title={`${s.index + 1}. ${s.node}${s.runIndex > 0 ? ` (run ${s.runIndex + 1})` : ''} · ${s.status}`}
              aria-label={`Step ${s.index + 1}: ${s.node}`}
              aria-current={s.index === step}
              onClick={() => showStep(s.index)}
              data-testid="tt-tick"
              data-status={s.status}
              className={cn(
                'h-5 min-w-1.5 flex-1 rounded-sm transition-all',
                TICK[s.status] ?? 'bg-subtle',
                s.index > step ? 'opacity-30' : 'opacity-100',
                s.index === step && 'scale-y-125 ring-2 ring-fg/80',
              )}
            />
          ))}
        </div>
        <span className="min-w-0 text-[12.5px]" data-testid="tt-label">
          <span className="font-medium">
            Step {step + 1} / {steps.length}
          </span>
          <span className="text-muted"> · {current.node}</span>
          {current.runIndex > 0 && <span className="text-subtle"> (run {current.runIndex + 1})</span>}
          <span className="text-subtle"> · {current.durationMs === null ? 'waiting' : duration(current.durationMs)}</span>
        </span>
        <select
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
          aria-label="Speed"
          data-testid="tt-speed"
          className="rounded-md border border-line bg-panel-2 px-1.5 py-1 text-[12px] text-muted"
        >
          {SPEEDS.map((v) => (
            <option key={v} value={v}>
              {v}x
            </option>
          ))}
        </select>
        <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} disabled={!canRerun} title={canRerun ? 'Run again from this node; earlier nodes reuse the recorded data' : 'This step cannot be re-run'} onClick={() => void rerun()} data-testid="tt-rerun">
          Re-run from here
        </Button>
        <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => leave()} data-testid="tt-exit">
          Exit
        </Button>
      </div>
    </div>
  );
}

/** INPUT / OUTPUT of the current step, with its duration and error. */
function StepPanel({ detail, stepIndex }: { detail: ExecutionDetail; stepIndex: number }) {
  const steps = useReplay((s) => s.steps);
  const step = steps[stepIndex]!;
  const [view, setView] = useState<ViewMode>(savedView());
  const [open, setOpen] = useState(true);
  const input = useMemo(() => stepInput(detail, step), [detail, step]);
  const output = useMemo(() => stepOutput(detail, step), [detail, step]);
  const run = detail.runData[step.node]?.[step.runIndex];
  const inItems = input.flat();
  const outItems = output.flat();
  const change = (v: ViewMode) => {
    setView(v);
    saveView(v);
  };
  return (
    <div data-testid="tt-panel">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-4 py-1.5 text-left text-[12px] text-muted hover:bg-panel-2" aria-expanded={open}>
        <span className="font-medium text-fg">{step.node}</span>
        <span data-testid="tt-status" data-status={step.status} className={cn(step.status === 'error' && 'text-danger', step.status === 'waiting' && 'text-warning')}>
          {step.status}
        </span>
        <span className="text-subtle">· {step.durationMs === null ? 'still waiting' : duration(step.durationMs)}</span>
        <span className="ml-auto text-subtle">{open ? 'Hide data' : 'Show data'}</span>
      </button>
      {open && (
        <div className="grid max-h-[34vh] grid-cols-1 gap-px border-t border-line bg-line md:grid-cols-2">
          <DataColumn title="INPUT" count={inItems.length} items={inItems} view={view} onView={change} testId="tt-input" empty="This step received no data (a trigger, or an AI sub-node)." />
          {run?.error ? (
            <div className="min-h-[80px] overflow-auto bg-panel p-3 text-[12.5px]" data-testid="tt-error">
              <div className="mb-1 flex items-center gap-1.5 font-semibold text-danger">
                <CircleAlert size={14} /> {run.error.name}
              </div>
              <div>{run.error.message}</div>
              {run.error.hint && <div className="mt-1 text-muted">{run.error.hint}</div>}
            </div>
          ) : (
            <DataColumn title="OUTPUT" count={outItems.length} items={outItems} view={view} onView={change} testId="tt-output" empty={step.status === 'waiting' ? 'Waiting for the resume call.' : 'No output.'} />
          )}
        </div>
      )}
    </div>
  );
}

function DataColumn({ title, count, items, view, onView, testId, empty }: { title: string; count: number; items: ReturnType<typeof stepInput>[number]; view: ViewMode; onView(v: ViewMode): void; testId: string; empty: string }) {
  const binary = hasBinary(items);
  const mode = view === 'binary' && !binary ? 'table' : view;
  return (
    <section className="flex min-h-[80px] min-w-0 flex-col bg-panel" data-testid={testId} data-count={count}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[11.5px]">
        <span className="font-semibold tracking-wide text-subtle">{title}</span>
        <span className="text-muted">{plural(count, 'item')}</span>
        <span className="ml-auto">
          <ViewSwitch view={mode} onChange={onView} binary={binary} />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{count === 0 ? <div className="p-3 text-[12.5px] text-subtle">{empty}</div> : <DataView items={items} view={mode} draggable={false} />}</div>
    </section>
  );
}
