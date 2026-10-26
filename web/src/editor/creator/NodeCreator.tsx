import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { NodeTypeInfo } from '@flowforge/shared';
import { cn } from '../../components/ui/cn';
import { aiOutput, aiSlots, GROUP_LABELS, iconFor, isTriggerType } from '../../lib/node-types';
import { listAllEdges } from '../graph';
import { NODE_DRAG_TYPE } from '../canvas/Canvas';
import { editor, useEditor } from '../store';

const GROUP_ORDER = ['trigger', 'flow', 'transform', 'files', 'network', 'integration', 'ai', 'note'];

function matches(t: NodeTypeInfo, q: string) {
  if (!q) return true;
  const hay = [t.displayName, t.description, ...(t.keywords ?? [])].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

let known = new Map<string, NodeTypeInfo>();
const nodeTypeOf = (type: string) => known.get(type);

/** Adds a node like the editor does from the creator or palette (auto-connect + open the panel). */
export function addFromCreator(type: NodeTypeInfo) {
  const s = useEditor.getState();
  let connectFrom = isTriggerType(type) || type.group === 'note' ? null : s.creator.connectFrom;
  const slot = aiOutput(type);
  if (slot && !connectFrom?.slot) {
    // A sub-node goes to the selected cluster node when that one has a free slot for it; otherwise it stays loose.
    const selected = s.selected.length === 1 ? s.nodes.find((n) => n.id === s.selected[0]) : undefined;
    const spec = selected ? aiSlots(nodeTypeOf(selected.type)).find((x) => x.type === slot) : undefined;
    const used = selected ? listAllEdges(s.connections).filter((e) => e.target === selected.name && e.type === slot).length : 0;
    connectFrom = selected && spec && (spec.maxConnections === undefined || used < spec.maxConnections) ? { node: selected.name, output: 0, slot } : null;
  } else if (connectFrom?.slot && connectFrom.slot !== slot) {
    connectFrom = null;
  }
  const node = editor.addNode(type, connectFrom === undefined ? {} : { connectFrom });
  editor.closeCreator();
  if (!isTriggerType(type) && type.group !== 'note') editor.openPanel(node.name);
  return node;
}

export function NodeCreator({ types }: { types: NodeTypeInfo[] }) {
  const open = useEditor((s) => s.creator.open);
  const hasTrigger = useEditor((s) => s.nodes.some((n) => isTriggerType(types.find((t) => t.type === n.type))));
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const slot = useEditor((s) => s.creator.connectFrom?.slot);
  useEffect(() => {
    known = new Map(types.map((t) => [t.type, t]));
  }, [types]);
  const groups = useMemo(() => {
    // Opened from an AI slot: only the sub-nodes that fit that slot are offered.
    const visible = types.filter((t) => matches(t, query.trim()) && (!slot || aiOutput(t) === slot));
    const order = hasTrigger ? GROUP_ORDER : ['trigger', ...GROUP_ORDER.filter((g) => g !== 'trigger')];
    return order
      .map((g) => ({ group: g, items: visible.filter((t) => t.group === g || (g === 'ai' && t.group === 'ai-sub')) }))
      .filter((g) => g.items.length > 0);
  }, [types, query, hasTrigger, slot]);
  const flat = groups.flatMap((g) => g.items);

  if (!open) return null;

  return (
    <aside
      className="absolute right-0 top-0 z-30 flex h-full w-[360px] animate-fade-in flex-col border-l border-line bg-panel shadow-2xl shadow-black/40"
      data-testid="node-creator"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          editor.closeCreator();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActive((a) => Math.min(flat.length - 1, a + 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActive((a) => Math.max(0, a - 1));
        } else if (e.key === 'Enter' && flat[active]) {
          e.preventDefault();
          addFromCreator(flat[active]!);
        }
      }}
    >
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <h2 className="text-[15px] font-semibold">{hasTrigger ? 'What happens next?' : 'What triggers this workflow?'}</h2>
        <button type="button" onClick={() => editor.closeCreator()} className="rounded p-1 text-subtle hover:bg-panel-3 hover:text-fg" aria-label="Close">
          <X size={16} />
        </button>
      </div>
      <div className="px-4 pb-3">
        <div className="flex h-9 items-center gap-2 rounded-md border border-line-strong bg-panel-2 px-2.5 focus-within:border-accent">
          <Search size={15} className="text-subtle" />
          <input
            ref={inputRef}
            data-testid="node-creator-search"
            className="h-full flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
            placeholder="Search nodes…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {groups.length === 0 && <p className="px-3 py-6 text-center text-[12.5px] text-subtle">No node matches "{query}"</p>}
        {groups.map((g) => (
          <div key={g.group} className="mb-2">
            <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">{GROUP_LABELS[g.group] ?? g.group}</div>
            {g.items.map((t) => {
              const Icon = iconFor(t.icon);
              const index = flat.indexOf(t);
              return (
                <button
                  key={t.type}
                  type="button"
                  draggable
                  data-testid={`creator-item-${t.type}`}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(NODE_DRAG_TYPE, t.type);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => addFromCreator(t)}
                  className={cn('flex w-full items-start gap-3 rounded-md px-2 py-2 text-left', index === active ? 'bg-panel-3' : 'hover:bg-panel-3')}
                >
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-panel-2">
                    <Icon size={17} style={{ color: t.defaults.color }} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{t.displayName}</span>
                    <span className="line-clamp-2 text-[12px] text-subtle">{t.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}
