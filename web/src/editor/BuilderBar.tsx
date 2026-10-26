import { useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { LoaderCircle, Sparkles, TriangleAlert, WifiOff, X } from 'lucide-react';
import type { BuildWorkflowResponse } from '@flowforge/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { cn } from '../components/ui/cn';
import { errorMessage } from '../lib/api';
import { buildWithAi, SUGGESTIONS } from './builder';
import { useEditor } from './store';

/** "Describe your automation…": builds a workflow from plain English and draws it on the canvas. */
export function BuilderBar() {
  const rf = useReactFlow();
  const empty = useEditor((s) => s.nodes.every((n) => n.type === 'flowforge.stickyNote'));
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BuildWorkflowResponse | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const expanded = open || busy || result !== null || error !== null;

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  const build = async (text: string) => {
    setConfirm(null);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await buildWithAi(text, () => void rf.fitView({ padding: 0.3, maxZoom: 1, duration: 200 })));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = (text: string) => {
    const clean = text.trim();
    if (!clean || busy) return;
    setPrompt(clean);
    // Building replaces what is on the canvas (one undo step brings it back).
    if (empty) void build(clean);
    else setConfirm(clean);
  };
  const close = () => {
    setOpen(false);
    setResult(null);
    setError(null);
  };

  if (!expanded && !empty) {
    return (
      <button
        type="button"
        data-testid="builder-open"
        onClick={() => setOpen(true)}
        className="absolute left-1/2 top-3 z-10 inline-flex h-9 -translate-x-1/2 items-center gap-2 rounded-full border border-line-strong bg-panel-2/95 px-4 text-[12.5px] text-muted shadow-lg backdrop-blur hover:border-accent hover:text-fg"
      >
        <Sparkles size={14} className="text-accent-hover" /> Build with AI
      </button>
    );
  }

  return (
    <div className="absolute left-1/2 top-3 z-10 w-[min(720px,calc(100%-9rem))] -translate-x-1/2" data-testid="builder-bar">
      <form
        className={cn('flex items-center gap-2 rounded-2xl border bg-panel-2/95 px-3 py-2 shadow-xl backdrop-blur', busy ? 'border-accent' : 'border-line-strong focus-within:border-accent')}
        onSubmit={(e) => {
          e.preventDefault();
          submit(prompt);
        }}
      >
        {busy ? <LoaderCircle size={17} className="shrink-0 animate-spin text-accent-hover" /> : <Sparkles size={17} className="shrink-0 text-accent-hover" />}
        <input
          ref={input}
          value={prompt}
          disabled={busy}
          maxLength={2000}
          data-testid="builder-input"
          placeholder="Describe your automation… e.g. email me the weather every morning"
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 bg-transparent py-1 text-[13.5px] outline-none placeholder:text-subtle"
        />
        <button type="submit" disabled={busy || prompt.trim().length < 3} data-testid="builder-submit" className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-accent-hover disabled:opacity-40">
          {busy ? 'Building…' : 'Build'}
        </button>
        {!empty && !busy && (
          <button type="button" title="Close" data-testid="builder-close" onClick={close} className="shrink-0 rounded p-1 text-subtle hover:bg-panel-3 hover:text-fg">
            <X size={15} />
          </button>
        )}
      </form>

      {!busy && !result && !error && (
        <div className="mt-2 flex flex-wrap justify-center gap-1.5" data-testid="builder-suggestions">
          {SUGGESTIONS.map((text) => (
            <button
              key={text}
              type="button"
              data-testid="builder-chip"
              onClick={() => submit(text)}
              className="rounded-full border border-line bg-panel-2/90 px-3 py-1 text-[11.5px] text-muted backdrop-blur hover:border-accent hover:text-fg"
            >
              {text}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="mt-2 flex items-start gap-2 rounded-xl border border-danger/40 bg-panel-2/95 px-3 py-2 text-[12.5px] text-danger" data-testid="builder-error">
          <TriangleAlert size={15} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {result && (
        <div className="mt-2 rounded-xl border border-line-strong bg-panel-2/95 px-3 py-2.5 text-[12.5px] shadow-lg backdrop-blur" data-testid="builder-result">
          <div className="flex flex-wrap items-center gap-2">
            <span
              data-testid="builder-label"
              data-source={result.source}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium',
                result.source === 'offline' ? 'bg-warning/15 text-warning' : 'bg-success/15 text-success',
              )}
            >
              {result.source === 'offline' ? <WifiOff size={12} /> : <Sparkles size={12} />} {result.label}
            </span>
            {result.template && (
              <span className="text-muted">
                "{result.template.name}"{result.template.weak ? ' (weak match: check that it fits)' : ''}
              </span>
            )}
            <button type="button" title="Close" onClick={close} className="ml-auto rounded p-1 text-subtle hover:bg-panel-3 hover:text-fg" data-testid="builder-result-close">
              <X size={14} />
            </button>
          </div>
          {result.reason && (
            <p className="mt-1.5 text-subtle" data-testid="builder-reason">
              {result.reason}
            </p>
          )}
          {result.notes.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-muted">
              {result.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          )}
          {result.missingCredentials.length > 0 && (
            <p className="mt-1.5 flex items-center gap-1.5 text-warning" data-testid="builder-missing">
              <TriangleAlert size={13} /> Nodes with this sign need a credential: open them to add it.
            </p>
          )}
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          title="Replace the current workflow?"
          message="The AI builder draws a new workflow in place of the nodes on the canvas. You can bring them back with Undo (Ctrl+Z)."
          confirmLabel="Replace and build"
          onConfirm={() => void build(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
