/** Timeline bar with node durations of the current / last run — owner: W2. Contract: docs/phase8-contracts.md */
import { memo, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { cn } from '../components/ui/cn';
import { formatDuration, timelineSegments } from './live';
import { editor, useEditor } from './store';

const COLORS: Record<string, string> = {
  success: 'bg-success/80',
  reused: 'bg-success/50',
  pinned: 'bg-[#c4a6ff]/70',
  error: 'bg-danger',
  waiting: 'bg-warning',
  running: 'bg-info',
};

export const ExecutionTimeline = memo(function ExecutionTimeline() {
  const [params] = useSearchParams();
  const log = useEditor((s) => s.execution.log);
  const [hover, setHover] = useState<number | null>(null);
  const segments = useMemo(() => timelineSegments(log), [log]);
  if (params.get('replay') === '1' || segments.length === 0) return null;
  const total = log.reduce((a, l) => a + (l.executionTime || 0), 0);
  const h = hover !== null ? segments[hover] : undefined;

  return (
    <div className="relative shrink-0 border-t border-line bg-panel px-3 py-1.5" data-testid="execution-timeline">
      <div className="mb-1 flex justify-between text-[10.5px] text-subtle">
        <span>{h ? `${h.node}${h.runIndex > 0 ? ` (run ${h.runIndex + 1})` : ''} · ${formatDuration(h.executionTime)}` : `${segments.length} node runs`}</span>
        <span>{formatDuration(total)}</span>
      </div>
      <div className="flex h-3 w-full gap-px overflow-hidden rounded">
        {segments.map((seg, i) => (
          <button
            key={`${seg.node}:${seg.runIndex}:${i}`}
            type="button"
            data-testid="timeline-segment"
            aria-label={`${seg.node}, ${formatDuration(seg.executionTime)}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onClick={() => editor.openPanel(seg.node)}
            style={{ width: `${seg.widthPct}%` }}
            className={cn('h-full min-w-[3px] cursor-pointer transition-opacity hover:opacity-80', COLORS[seg.status] ?? 'bg-subtle')}
          />
        ))}
      </div>
    </div>
  );
});
