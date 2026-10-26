/** Demo Mode narration, step controls (Skip step / Stop demo) inside the editor — owner: W3. Contract: docs/phase8-contracts.md */
import { useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Play, SkipForward, Square } from 'lucide-react';
import { QrDialog } from '../components/QrDialog';
import { cn } from '../components/ui/cn';
import { DEMO_STEPS, RESULT_SYMBOL, STEP_COUNT, summarizeResults } from './demo-script';
import { runDemoScript } from './demo-runner';
import { skipDemoStep, stopDemo, useDemo } from './demo-store';

let mounted = 0;

export function DemoOverlay() {
  const rf = useReactFlow();
  const { state, formUrl, detail, build } = useDemo();
  const started = useRef<number | null>(null);
  const [qrHidden, setQrHidden] = useState(false);

  // The script starts when the editor opens the demo workflow; leaving the editor stops the demo.
  useEffect(() => {
    mounted++;
    const demo = useDemo.getState();
    if (demo.state.phase === 'running' && demo.runId !== started.current) {
      started.current = demo.runId;
      void runDemoScript(() => void rf.fitView({ padding: 0.3, maxZoom: 1, duration: 200 }));
    }
    return () => {
      mounted--;
      setTimeout(() => {
        if (mounted === 0) stopDemo();
      }, 50);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.phase === 'idle' || state.phase === 'stopped') return null;
  const results = state.step === STEP_COUNT - 1 ? summarizeResults(detail) : [];
  const last = state.step === STEP_COUNT - 1;

  return (
    <>
      <div
        className="pointer-events-auto fixed bottom-4 left-1/2 z-[70] w-[min(560px,calc(100%-32px))] -translate-x-1/2 rounded-xl border border-line bg-panel/95 p-4 shadow-2xl backdrop-blur"
        data-testid="demo-overlay"
        data-step={state.step + 1}
        data-phase={state.phase}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-wide text-accent">
            <Play size={13} /> Demo Mode
            <span data-testid="demo-step" className="text-subtle">
              Step {state.step + 1} / {STEP_COUNT}: {DEMO_STEPS[state.step]}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {!last && (
              <button onClick={skipDemoStep} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[12px] text-muted hover:bg-panel-3 hover:text-fg" data-testid="demo-skip">
                <SkipForward size={13} /> Skip step
              </button>
            )}
            <button onClick={stopDemo} className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[12px] text-muted hover:bg-panel-3 hover:text-fg" data-testid="demo-stop">
              <Square size={12} /> {last ? 'Close' : 'Stop demo'}
            </button>
          </div>
        </div>
        <div className="mt-1 flex gap-1" aria-hidden>
          {DEMO_STEPS.map((name, i) => (
            <div key={name} className={cn('h-1 flex-1 rounded-full bg-panel-3', i <= state.step && 'bg-accent')} />
          ))}
        </div>
        <p className="mt-2 text-[14px]" data-testid="demo-narration">
          {state.narration}
        </p>
        {state.simulatedSubmission && state.step >= 2 && (
          <p className="mt-1 text-[12px] text-warning" data-testid="demo-simulating">
            Simulating a submission: Demo Mode filled in the form for you.
          </p>
        )}
        {formUrl && qrHidden && state.step >= 1 && state.step <= 2 && (
          <button onClick={() => setQrHidden(false)} className="mt-1 text-[12px] text-accent hover:underline" data-testid="demo-show-qr">
            Show the QR code again
          </button>
        )}
        {state.fallbacks.length > 0 && <p className="mt-1 text-[12px] text-subtle">{state.fallbacks.join(' · ')}</p>}
        {last && (
          <ul className="mt-3 flex flex-col gap-1.5" data-testid="demo-results">
            {results.length === 0 && <li className="text-[13px] text-subtle">Loading the results...</li>}
            {results.map((r) => (
              <li key={r.id} data-testid="demo-result" data-status={r.status} className={cn('flex items-center gap-2 text-[13px]', r.status === 'sent' && 'text-success', r.status === 'simulated' && 'text-warning', r.status === 'failed' && 'text-danger', r.status === 'skipped' && 'text-subtle')}>
                <span className="w-4 text-center font-semibold">{RESULT_SYMBOL[r.status]}</span>
                {r.text}
              </li>
            ))}
          </ul>
        )}
        {build && last && build.label && <p className="mt-2 text-[11px] text-subtle">Workflow: {build.label}</p>}
      </div>
      {formUrl && state.step >= 1 && state.step <= 2 && !qrHidden && (
        <QrDialog url={formUrl} title="Scan with your phone" openHref={formUrl} note="Fill in the form to start the demo." onClose={() => setQrHidden(true)} />
      )}
    </>
  );
}
