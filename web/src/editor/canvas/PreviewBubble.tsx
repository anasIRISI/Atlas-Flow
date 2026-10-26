import { memo } from 'react';
import type { Item } from '@flowforge/shared';
import { plural } from '../../lib/format';
import { truncatePreview } from '../live';

/** Small hover bubble with the first items (max 3 / 2 KB) of a finished node or edge. Mounted on hover only. */
export const PreviewBubble = memo(function PreviewBubble({ items, title, className }: { items: Item[] | undefined; title?: string; className?: string }) {
  const p = truncatePreview(items);
  return (
    <div
      className={`ff-bubble pointer-events-none absolute z-50 w-[260px] rounded-lg border border-line-strong bg-panel p-2 text-left shadow-xl ${className ?? ''}`}
      data-testid="data-preview"
    >
      <div className="mb-1 flex justify-between text-[10.5px] text-subtle">
        <span className="truncate">{title}</span>
        <span>{plural(p.total, 'item')}</span>
      </div>
      <pre className="max-h-40 overflow-hidden whitespace-pre-wrap break-all font-mono text-[10.5px] leading-snug text-fg">{p.text}</pre>
      {p.truncated && <div className="mt-1 text-[10px] text-subtle">… more in the output panel</div>}
    </div>
  );
});
