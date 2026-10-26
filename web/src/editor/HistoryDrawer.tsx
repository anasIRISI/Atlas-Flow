import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, History, RotateCcw, X } from 'lucide-react';
import type { WorkflowVersionDetail, WorkflowVersionSummary } from '@flowforge/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { cn } from '../components/ui/cn';
import { Spinner } from '../components/ui/Spinner';
import { api, errorMessage } from '../lib/api';
import { restoreVersion } from './actions';
import { useEditor } from './store';

const SOURCE: Record<string, string> = { create: 'Created', save: 'Saved', import: 'Imported', restore: 'Restored' };

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleString();
}

function Summary({ v }: { v: WorkflowVersionSummary }) {
  const d = v.diff;
  const changed = d.changed.length + d.renamed.length;
  return (
    <span className="font-mono text-[12px]" data-testid="version-diff">
      <span className="text-success">+{d.added.length}</span> <span className="text-danger">−{d.removed.length}</span> <span className="text-warning">~{changed}</span>
    </span>
  );
}

function Details({ v }: { v: WorkflowVersionSummary }) {
  const d = v.diff;
  const lines: string[] = [
    ...d.added.map((n) => `Added: ${n}`),
    ...d.removed.map((n) => `Removed: ${n}`),
    ...d.renamed.map((r) => `Renamed: ${r.from} → ${r.to}`),
    ...d.changed.map((c) => `Changed: ${c.node} (${c.fields.join(', ')})`),
    ...(d.connectionsChanged ? ['Connections changed'] : []),
    ...(d.settingsChanged ? ['Workflow settings changed'] : []),
    ...(d.nameChanged ? ['Workflow name changed'] : []),
  ];
  if (v.number === 1) lines.unshift(`${v.nodeCount} node(s) in the first version`);
  if (!lines.length) lines.push('No visible changes');
  return (
    <ul className="mt-2 space-y-0.5 border-l border-line pl-3 text-[12px] text-muted">
      {lines.map((l, i) => (
        <li key={i} className="truncate" title={l}>
          {l}
        </li>
      ))}
    </ul>
  );
}

export function HistoryDrawer({ onClose }: { onClose(): void }) {
  const workflowId = useEditor((s) => s.workflowId);
  const dirty = useEditor((s) => s.dirty);
  const [versions, setVersions] = useState<WorkflowVersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<WorkflowVersionSummary | null>(null);
  const [preview, setPreview] = useState<WorkflowVersionDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!workflowId) return;
    setError(null);
    api<WorkflowVersionSummary[]>(`/workflows/${workflowId}/versions`).then(setVersions, (e) => setError(errorMessage(e)));
  };
  useEffect(load, [workflowId]); // eslint-disable-line react-hooks/exhaustive-deps

  const showPreview = async (n: number) => {
    try {
      setPreview(await api<WorkflowVersionDetail>(`/workflows/${workflowId}/versions/${n}`));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <aside className="fixed bottom-0 right-0 top-14 z-40 flex w-[380px] max-w-full flex-col border-l border-line bg-panel shadow-2xl" data-testid="history-drawer">
      <div className="flex h-12 items-center gap-2 border-b border-line px-4">
        <History size={15} className="text-muted" />
        <h2 className="text-[14px] font-semibold">Version history</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded p-1.5 text-subtle hover:bg-panel-3 hover:text-fg">
          <X size={15} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {error && (
          <Alert>
            Could not load the history: {error} <button className="underline" onClick={load}>Retry</button>
          </Alert>
        )}
        {!versions && !error && (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        )}
        {versions && !versions.length && <p className="py-10 text-center text-[13px] text-muted">No versions yet. Save the workflow to create the first one.</p>}
        <ul className="space-y-2">
          {versions?.map((v) => (
            <li key={v.number} className="rounded-lg border border-line bg-panel-2 p-3" data-testid={`version-${v.number}`}>
              <div className="flex items-center gap-2 text-[12.5px]">
                <button type="button" onClick={() => setOpen(open === v.number ? null : v.number)} className="text-subtle hover:text-fg" aria-label="Show changes">
                  {open === v.number ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <span className="font-semibold">Version {v.number}</span>
                <span className={cn('rounded px-1.5 py-0.5 text-[10.5px] uppercase', v.source === 'restore' ? 'bg-warning/15 text-warning' : 'bg-panel-3 text-muted')}>
                  {SOURCE[v.source] ?? v.source}
                  {v.restoredFrom ? ` v${v.restoredFrom}` : ''}
                </span>
                <span className="ml-auto text-subtle" title={new Date(v.createdAt).toLocaleString()}>
                  {ago(v.createdAt)}
                </span>
              </div>
              {v.note && <p className="mt-1.5 break-words text-[12.5px] text-fg">{v.note}</p>}
              <div className="mt-1.5 flex items-center gap-2">
                <Summary v={v} />
                <span className="text-[12px] text-subtle">{v.nodeCount} nodes</span>
                <div className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" icon={<Eye size={13} />} onClick={() => void showPreview(v.number)} data-testid={`preview-${v.number}`}>
                    Preview
                  </Button>
                  <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} loading={busy} onClick={() => setConfirm(v)} data-testid={`restore-${v.number}`}>
                    Restore
                  </Button>
                </div>
              </div>
              {open === v.number && <Details v={v} />}
            </li>
          ))}
        </ul>
      </div>
      {preview && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && setPreview(null)}>
          <div className="flex max-h-[80vh] w-[640px] max-w-[92vw] flex-col rounded-xl border border-line-strong bg-panel p-5 shadow-2xl">
            <h2 className="text-[16px] font-semibold">
              Version {preview.number}: {preview.name}
            </h2>
            <p className="mt-1 text-[12.5px] text-muted">{preview.nodes.map((n) => n.name).join(', ') || 'No nodes'}</p>
            <pre className="mt-3 flex-1 overflow-auto rounded border border-line bg-panel-2 p-3 text-[11.5px]">
              {JSON.stringify({ nodes: preview.nodes, connections: preview.connections, settings: preview.settings }, null, 2)}
            </pre>
            <div className="mt-4 flex justify-end">
              <Button variant="secondary" onClick={() => setPreview(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Restore version ${confirm.number}?`}
          message={`The workflow becomes a copy of version ${confirm.number} and a new version is added to the history.${dirty ? ' You have unsaved changes in the editor: they will be lost.' : ''}`}
          confirmLabel="Restore"
          danger={dirty}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const n = confirm.number;
            setConfirm(null);
            setBusy(true);
            await restoreVersion(n);
            setBusy(false);
            load();
          }}
        />
      )}
    </aside>
  );
}
