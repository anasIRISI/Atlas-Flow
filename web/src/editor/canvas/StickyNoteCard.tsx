import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import { cn } from '../../components/ui/cn';
import { editor, useEditor } from '../store';

export const STICKY_COLORS = ['#ffd233', '#ff9b5a', '#ff6b8a', '#5bd18b', '#5cb8ff', '#b28dff', '#9aa0a6'];

/** Tiny Markdown renderer (headings, lists, bold, italic, code, links) without HTML injection. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={m.index}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={m.index} className="rounded bg-black/10 px-1">{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(t)!;
      out.push(
        <a key={m.index} href={/^https?:\/\//.test(href!) ? href : undefined} target="_blank" rel="noreferrer" className="underline">
          {label}
        </a>,
      );
    } else out.push(<em key={m.index}>{t.slice(1, -1)}</em>);
    last = m.index! + t.length;
  }
  out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        if (/^###\s/.test(line)) return <h3 key={i} className="text-[13px] font-semibold">{inline(line.slice(4))}</h3>;
        if (/^##\s/.test(line)) return <h2 key={i} className="text-[15px] font-semibold">{inline(line.slice(3))}</h2>;
        if (/^#\s/.test(line)) return <h1 key={i} className="text-[17px] font-bold">{inline(line.slice(2))}</h1>;
        if (/^[-*]\s/.test(line)) return <li key={i} className="ml-4 list-disc">{inline(line.slice(2))}</li>;
        if (line.trim() === '') return <div key={i} className="h-2" />;
        return <p key={i}>{inline(line)}</p>;
      })}
    </>
  );
}

/** A sticky note: resizable, colored, double-click to edit (Markdown). */
export const StickyNoteCard = memo(function StickyNoteCard({ id, selected }: NodeProps) {
  const node = useEditor((s) => s.nodes.find((n) => n.id === id));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);
  if (!node) return null;
  const p = node.parameters as { content?: string; width?: number; height?: number; color?: number };
  const color = STICKY_COLORS[((p.color ?? 1) - 1 + STICKY_COLORS.length) % STICKY_COLORS.length]!;
  const save = () => {
    setEditing(false);
    if (draft !== p.content) editor.updateParameters(node.name, { ...node.parameters, content: draft }, `sticky:${node.name}:${Date.now()}`);
  };

  return (
    <div
      className={cn('relative flex h-full w-full flex-col overflow-hidden rounded-lg border-2 text-[#1d1d1f] shadow-md', selected ? 'border-accent' : 'border-transparent')}
      style={{ background: `${color}e6` }}
      data-testid="sticky-note"
      data-node-name={node.name}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setDraft(p.content ?? '');
        setEditing(true);
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={150}
        minHeight={80}
        lineClassName="!border-accent/60"
        handleClassName="!size-2.5 !rounded-sm !border-accent !bg-panel"
        onResizeStart={() => editor.beginChange(`resize:${Date.now()}`)}
        onResizeEnd={(_e, size) =>
          useEditor.setState((s) => ({
            nodes: s.nodes.map((n) =>
              n.id === id
                ? { ...n, position: [Math.round(size.x), Math.round(size.y)], parameters: { ...n.parameters, width: Math.round(size.width), height: Math.round(size.height) } }
                : n,
            ),
            dirty: true,
          }))
        }
      />
      {editing ? (
        <textarea
          ref={area}
          data-testid="sticky-editor"
          className="nodrag nowheel h-full w-full resize-none bg-transparent p-3 font-mono text-[12.5px] outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              save();
            }
          }}
        />
      ) : (
        <div className="h-full overflow-auto p-3 text-[13px] leading-snug">
          <Markdown text={p.content ?? ''} />
        </div>
      )}
      {selected && !editing && (
        <div className="nodrag absolute bottom-1.5 right-1.5 flex gap-1 rounded-full bg-black/25 p-1">
          {STICKY_COLORS.map((c, i) => (
            <button
              key={c}
              type="button"
              title="Color"
              onClick={() => editor.updateParameters(node.name, { ...node.parameters, color: i + 1 })}
              className={cn('size-3.5 rounded-full border border-black/30', (p.color ?? 1) === i + 1 && 'ring-2 ring-white')}
              style={{ background: c }}
            />
          ))}
        </div>
      )}
    </div>
  );
});
