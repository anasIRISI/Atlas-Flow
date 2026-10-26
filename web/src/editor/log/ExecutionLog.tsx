import { useSearchParams } from 'react-router';
import { ChevronDown, History, ChevronUp, CircleAlert, CircleCheck, Hourglass, LoaderCircle, Pin, PowerOff, RotateCcw } from 'lucide-react';
import { cn } from '../../components/ui/cn';
import { duration, plural } from '../../lib/format';
import { editor, isRunning, useEditor, type RunState } from '../store';

const STATUS_TEXT: Partial<Record<RunState, string>> = {
  starting: 'Starting…',
  queued: 'Waiting in queue…',
  running: 'Running…',
  waiting: 'Waiting…',
  success: 'Succeeded',
  error: 'Failed',
  canceled: 'Stopped',
  crashed: 'Crashed',
};

/** Bottom panel: one row per executed node, live. */
export function ExecutionLog() {
  const open = useEditor((s) => s.logOpen);
  const ex = useEditor((s) => s.execution);
  const [, setSearch] = useSearchParams();
  if (ex.status === 'idle') return null;
  const total = ex.finishedAt && ex.startedAt ? ex.finishedAt - ex.startedAt : undefined;
  return (
    <div className="border-t border-line bg-panel" data-testid="execution-log">
      <button type="button" onClick={() => editor.setUi({ logOpen: !open })} className="flex w-full items-center gap-2 px-4 py-2 text-left text-[12.5px]">
        {ex.status === 'waiting' ? (
          <Hourglass size={14} className="text-warning" />
        ) : isRunning(ex.status) ? (
          <LoaderCircle size={14} className="animate-spin text-info" />
        ) : ex.status === 'success' ? (
          <CircleCheck size={14} className="text-success" />
        ) : (
          <CircleAlert size={14} className="text-danger" />
        )}
        <span className="font-medium" data-testid="execution-status" data-status={ex.status}>
          {STATUS_TEXT[ex.status] ?? ex.status}
        </span>
        {ex.destination && <span className="text-subtle">· step "{ex.destination}"</span>}
        {total !== undefined && <span className="text-subtle">· {duration(total)}</span>}
        {ex.error && !isRunning(ex.status) && <span className="truncate text-danger">· {ex.error.message}</span>}
        {ex.id && !isRunning(ex.status) && ex.log.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-accent-hover hover:bg-accent-soft"
            data-testid="log-time-travel"
            onClick={(e) => {
              e.stopPropagation();
              setSearch({ execution: ex.id!, replay: '1' });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                setSearch({ execution: ex.id!, replay: '1' });
              }
            }}
          >
            <History size={12} /> Time travel
          </span>
        )}
        <span className={ex.id && !isRunning(ex.status) && ex.log.length > 0 ? 'text-subtle' : 'ml-auto text-subtle'}>{open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</span>
      </button>
      {ex.status === 'waiting' && ex.waiting && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-warning/5 px-4 py-2 text-[12.5px]" data-testid="waiting-info">
          <Hourglass size={13} className="text-warning" />
          <span>
            "{ex.waiting.node}" is waiting
            {ex.waiting.till
              ? ` until ${new Date(ex.waiting.till).toLocaleString()}`
              : ex.waiting.kind === 'form'
                ? ' for the form to be submitted'
                : ' for a call to its resume URL'}
          </span>
          {ex.waiting.kind !== 'time' && (
            <a href={ex.waiting.resumeUrl} target="_blank" rel="noreferrer" className="truncate font-mono text-[12px] text-accent-hover underline" data-testid="resume-url">
              {ex.waiting.resumeUrl}
            </a>
          )}
        </div>
      )}
      {open && (
        <div className="max-h-40 overflow-y-auto border-t border-line px-2 py-1">
          {ex.log.length === 0 && <div className="px-2 py-2 text-[12px] text-subtle">Waiting for the first node…</div>}
          {ex.log.map((entry, i) => (
            <button
              key={i}
              type="button"
              onClick={() => editor.openPanel(entry.node)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12.5px] hover:bg-panel-2"
              data-testid="log-row"
            >
              {entry.status === 'error' ? (
                <CircleAlert size={13} className="text-danger" />
              ) : entry.status === 'pinned' ? (
                <Pin size={13} className="text-[#c4a6ff]" />
              ) : entry.status === 'disabled' ? (
                <PowerOff size={13} className="text-subtle" />
              ) : entry.status === 'reused' ? (
                <RotateCcw size={13} className="text-subtle" />
              ) : (
                <CircleCheck size={13} className="text-success" />
              )}
              <span className="min-w-0 flex-1 truncate font-medium">
                {entry.node}
                {entry.runIndex > 0 && <span className="text-subtle"> (run {entry.runIndex + 1})</span>}
              </span>
              <span className={cn('text-[12px]', entry.status === 'error' ? 'text-danger' : 'text-muted')}>
                {entry.status === 'error' ? entry.error?.message : plural(entry.itemCounts.reduce((a, b) => a + b, 0), 'item')}
              </span>
              <span className="w-16 text-right text-[11.5px] text-subtle">{duration(entry.executionTime)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
