import { useMemo, useState, type DragEvent } from 'react';
import { Download, ExternalLink, File as FileIcon } from 'lucide-react';
import type { BinaryRef, Item } from '@flowforge/shared';
import { cn } from '../../components/ui/cn';
import { FIELD_DRAG_TYPE, jsonPath, type DraggedField } from '../../lib/expressions';
import { formatBytes } from '../../lib/format';

export type ViewMode = 'schema' | 'table' | 'json' | 'binary';

/** True when at least one item carries a file. */
export const hasBinary = (items: Item[]) => items.some((item) => item.binary && Object.keys(item.binary).length > 0);

const fileUrl = (ref: BinaryRef, download = false) => `/api/binary-data/${ref.id}${download ? '?download=1' : ''}`;

/** Files of the items: name, type, size, preview of images, view and download. */
function BinaryView({ items }: { items: Item[] }) {
  const files = items.slice(0, MAX_ROWS).flatMap((item, index) => Object.entries(item.binary ?? {}).map(([property, ref]) => ({ index, property, ref })));
  if (files.length === 0) return <div className="p-4 text-[12.5px] text-subtle">These items have no files.</div>;
  return (
    <div className="flex flex-col gap-2 overflow-auto p-3" data-testid="data-binary">
      {files.map(({ index, property, ref }) => (
        <div key={`${index}-${property}`} className="flex items-center gap-3 rounded-lg border border-line bg-panel-2/60 p-2.5" data-testid="binary-file" data-property={property}>
          {ref.mimeType.startsWith('image/') && ref.fileSize < 5 * 1024 * 1024 ? (
            <img src={fileUrl(ref)} alt="" className="size-14 shrink-0 rounded border border-line bg-white object-contain" />
          ) : (
            <div className="grid size-14 shrink-0 place-items-center rounded border border-line bg-panel text-subtle">
              <FileIcon size={22} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium" data-testid="binary-file-name">
              {ref.fileName ?? 'file'}
            </div>
            <div className="truncate text-[11.5px] text-subtle">
              item {index} · <code className="rounded bg-panel-3 px-1">{property}</code> · {ref.mimeType} · {formatBytes(ref.fileSize)}
            </div>
          </div>
          <a href={fileUrl(ref)} target="_blank" rel="noreferrer" title="View" data-testid="binary-view" className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-fg">
            <ExternalLink size={15} />
          </a>
          <a href={fileUrl(ref, true)} title="Download" data-testid="binary-download" className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-fg">
            <Download size={15} />
          </a>
        </div>
      ))}
      {items.length > MAX_ROWS && <div className="text-[12px] text-subtle">Showing the files of the first {MAX_ROWS} items</div>}
    </div>
  );
}

const VIEW_KEY = 'ff.dataView';
export const savedView = (): ViewMode => (localStorage.getItem(VIEW_KEY) as ViewMode) || 'table';
export const saveView = (v: ViewMode) => localStorage.setItem(VIEW_KEY, v);

const MAX_ROWS = 100;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function dragStart(e: DragEvent, segments: Array<string | number>) {
  const path = jsonPath('$json', segments);
  const last = segments.filter((s) => typeof s === 'string').pop();
  const payload: DraggedField = { expression: `{{ ${path} }}`, name: String(last ?? 'value'), valueType: 'string' };
  e.dataTransfer.setData(FIELD_DRAG_TYPE, JSON.stringify(payload));
  e.dataTransfer.setData('text/plain', `{{ ${path} }}`);
  e.dataTransfer.effectAllowed = 'copy';
}

function Draggable({ segments, enabled, children, valueType }: { segments: Array<string | number>; enabled: boolean; children: React.ReactNode; valueType?: string }) {
  if (!enabled) return <>{children}</>;
  return (
    <span
      draggable
      data-drag-field={jsonPath('$json', segments)}
      onDragStart={(e) => {
        dragStart(e, segments);
        if (valueType) {
          const payload = JSON.parse(e.dataTransfer.getData(FIELD_DRAG_TYPE)) as DraggedField;
          e.dataTransfer.setData(FIELD_DRAG_TYPE, JSON.stringify({ ...payload, valueType }));
        }
      }}
      className="cursor-grab rounded px-1 hover:bg-accent-soft hover:text-accent-hover active:cursor-grabbing"
      title="Drag into a parameter"
    >
      {children}
    </span>
  );
}

function Cell({ value }: { value: unknown }) {
  if (value === undefined) return <span className="text-subtle"></span>;
  if (value === null) return <span className="text-subtle">null</span>;
  if (typeof value === 'object') return <span className="font-mono text-[11.5px] text-muted">{JSON.stringify(value).slice(0, 120)}</span>;
  if (typeof value === 'boolean') return <span className="text-[#f9b872]">{String(value)}</span>;
  if (typeof value === 'number') return <span className="text-[#f9b872]">{value}</span>;
  return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}

function TableView({ items, draggable }: { items: Item[]; draggable: boolean }) {
  const rows = items.slice(0, MAX_ROWS);
  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const item of rows.slice(0, 50)) for (const k of Object.keys(item.json)) keys.add(k);
    return [...keys];
  }, [rows]);
  const files = hasBinary(rows);
  if (columns.length === 0 && !files) return <div className="p-4 text-[12.5px] text-subtle">{items.length} empty item{items.length === 1 ? '' : 's'}</div>;
  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-[12.5px]" data-testid="data-table">
        <thead>
          <tr>
            <th className="sticky top-0 w-8 border-b border-line bg-panel-2 px-2 py-1.5 text-left font-medium text-subtle">#</th>
            {columns.map((c) => (
              <th key={c} className="sticky top-0 border-b border-l border-line bg-panel-2 px-2 py-1.5 text-left font-medium text-muted">
                <Draggable segments={[c]} enabled={draggable} valueType={typeOf(rows.find((r) => r.json[c] !== undefined)?.json[c])}>
                  {c}
                </Draggable>
              </th>
            ))}
            {files && <th className="sticky top-0 border-b border-l border-line bg-panel-2 px-2 py-1.5 text-left font-medium text-muted">Files</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((item, i) => (
            <tr key={i} className="align-top hover:bg-panel-2/60">
              <td className="border-b border-line px-2 py-1.5 text-subtle">{i}</td>
              {columns.map((c) => (
                <td key={c} className="max-w-[260px] border-b border-l border-line px-2 py-1.5">
                  <Cell value={item.json[c]} />
                </td>
              ))}
              {files && (
                <td className="border-b border-l border-line px-2 py-1.5" data-testid="table-files">
                  {Object.entries(item.binary ?? {}).map(([property, ref]) => (
                    <a key={property} href={fileUrl(ref)} target="_blank" rel="noreferrer" title={`${property} · ${ref.mimeType} · ${formatBytes(ref.fileSize)}`} className="mr-2 inline-flex items-center gap-1 text-accent-hover hover:underline">
                      <FileIcon size={12} /> {ref.fileName ?? property}
                    </a>
                  ))}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {items.length > MAX_ROWS && <div className="p-2 text-[12px] text-subtle">Showing the first {MAX_ROWS} of {items.length} items</div>}
    </div>
  );
}

const TOKEN = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function JsonView({ items }: { items: Item[] }) {
  const text = useMemo(() => JSON.stringify(items.slice(0, MAX_ROWS).map((i) => i.json), null, 2), [items]);
  const parts = useMemo(() => {
    const out: Array<{ t: string; c?: string }> = [];
    let last = 0;
    for (const m of text.matchAll(TOKEN)) {
      if (m.index! > last) out.push({ t: text.slice(last, m.index) });
      const token = m[0];
      const c = token.startsWith('"') ? (token.trimEnd().endsWith(':') ? 'text-[#b4c7ff]' : 'text-[#a5d6a7]') : 'text-[#f9b872]';
      out.push({ t: token, c });
      last = m.index! + token.length;
    }
    out.push({ t: text.slice(last) });
    return out;
  }, [text]);
  return (
    <pre className="overflow-auto p-3 font-mono text-[12px] leading-relaxed" data-testid="data-json">
      {parts.map((p, i) => (p.c ? <span key={i} className={p.c}>{p.t}</span> : p.t))}
    </pre>
  );
}

interface SchemaNode {
  key: string | number;
  segments: Array<string | number>;
  type: string;
  sample?: unknown;
  children?: SchemaNode[];
}

function buildSchema(value: unknown, segments: Array<string | number>): SchemaNode[] {
  if (Array.isArray(value)) {
    return value.length ? [{ key: 0, segments: [...segments, 0], type: typeOf(value[0]), sample: value[0], children: childrenOf(value[0], [...segments, 0]) }] : [];
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([k, v]) => ({
      key: k,
      segments: [...segments, k],
      type: typeOf(v),
      sample: v,
      children: childrenOf(v, [...segments, k]),
    }));
  }
  return [];
}

const childrenOf = (v: unknown, segments: Array<string | number>) => (v && typeof v === 'object' ? buildSchema(v, segments) : undefined);

function SchemaRows({ nodes, depth, draggable }: { nodes: SchemaNode[]; depth: number; draggable: boolean }) {
  return (
    <>
      {nodes.map((n) => (
        <div key={String(n.key)}>
          <div className="flex items-center gap-2 py-0.5 text-[12.5px]" style={{ paddingLeft: depth * 14 }}>
            <span className="w-12 shrink-0 rounded bg-panel-3 px-1 text-center text-[10px] uppercase text-subtle">{n.type}</span>
            <Draggable segments={n.segments} enabled={draggable} valueType={n.type}>
              <span className="font-medium">{typeof n.key === 'number' ? `[${n.key}]` : n.key}</span>
            </Draggable>
            {!n.children && <span className="truncate text-muted">{n.sample === null ? 'null' : String(n.sample)}</span>}
          </div>
          {n.children && <SchemaRows nodes={n.children} depth={depth + 1} draggable={draggable} />}
        </div>
      ))}
    </>
  );
}

function SchemaView({ items, draggable }: { items: Item[]; draggable: boolean }) {
  const schema = useMemo(() => buildSchema(items[0]?.json ?? {}, []), [items]);
  if (!schema.length) return <div className="p-4 text-[12.5px] text-subtle">No fields</div>;
  return (
    <div className="overflow-auto p-3" data-testid="data-schema">
      <SchemaRows nodes={schema} depth={0} draggable={draggable} />
    </div>
  );
}

/** Items shown as Table / JSON / Schema. Input data is draggable into parameters. */
export function DataView({ items, view, draggable }: { items: Item[]; view: ViewMode; draggable: boolean }) {
  if (view === 'binary' && hasBinary(items)) return <BinaryView items={items} />;
  if (view === 'json') return <JsonView items={items} />;
  if (view === 'schema') return <SchemaView items={items} draggable={draggable} />;
  return <TableView items={items} draggable={draggable} />;
}

export function ViewSwitch({ view, onChange, binary }: { view: ViewMode; onChange(v: ViewMode): void; binary?: boolean }) {
  const [, force] = useState(0);
  return (
    <div className="flex overflow-hidden rounded-md border border-line text-[11.5px]">
      {((binary ? ['schema', 'table', 'json', 'binary'] : ['schema', 'table', 'json']) as ViewMode[]).map((v) => (
        <button
          key={v}
          type="button"
          data-testid={`view-${v}`}
          onClick={() => {
            // "Binary" only exists for some nodes: it is not remembered as the favourite view.
            if (v !== 'binary') saveView(v);
            onChange(v);
            force((n) => n + 1);
          }}
          className={cn('px-2 py-1 capitalize', (view === v || (v === 'table' && view === 'binary' && !binary)) ? 'bg-panel-3 text-fg' : 'text-subtle hover:text-fg')}
        >
          {v === 'json' ? 'JSON' : v}
        </button>
      ))}
    </div>
  );
}
