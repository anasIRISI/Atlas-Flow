import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { History, RefreshCw, Trash2 } from 'lucide-react';
import type { ExecutionListItem, ExecutionMode, ExecutionStatus } from '@flowforge/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Spinner } from '../components/ui/Spinner';
import { errorMessage } from '../lib/api';
import { useDeleteExecutions, useExecutionPages } from '../lib/executions-api';
import { duration, plural, timeAgo } from '../lib/format';
import { toast } from '../lib/toast';
import { useTitle } from '../lib/useTitle';
import { useWorkflows } from '../lib/workflows-api';
import { PageHeader } from './PageHeader';

export const STATUS_STYLE: Record<ExecutionStatus, { label: string; cls: string }> = {
  success: { label: 'Success', cls: 'bg-success/15 text-[#a6efc6]' },
  error: { label: 'Error', cls: 'bg-danger/15 text-[#ffb4b2]' },
  running: { label: 'Running', cls: 'bg-info/15 text-[#b8d8ff]' },
  queued: { label: 'Queued', cls: 'bg-panel-3 text-muted' },
  waiting: { label: 'Waiting', cls: 'bg-warning/15 text-[#ffd699]' },
  canceled: { label: 'Canceled', cls: 'bg-panel-3 text-muted' },
  crashed: { label: 'Crashed', cls: 'bg-danger/15 text-[#ffb4b2]' },
};
const STATUSES = Object.keys(STATUS_STYLE) as ExecutionStatus[];
const MODES: ExecutionMode[] = ['manual', 'trigger', 'webhook', 'schedule', 'form', 'chat', 'error', 'subworkflow', 'retry'];

export function StatusBadge({ status }: { status: ExecutionStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium', s.cls)} data-testid="execution-status-badge" data-status={status}>
      {s.label}
    </span>
  );
}

const selectCls = 'h-8 rounded-md border border-line-strong bg-panel-2 px-2 text-[13px] text-fg focus:border-accent focus:outline-none';

/** Date input value (yyyy-mm-dd) to an ISO bound in local time. */
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const dayEnd = (d: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);

export function ExecutionsPage() {
  useTitle('Historique');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const workflowId = params.get('workflowId') ?? '';
  const status = (params.get('status') ?? '').split(',').filter(Boolean) as ExecutionStatus[];
  const mode = params.get('mode') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setSelected(new Set());
  };
  const toggleStatus = (s: ExecutionStatus) => setParam('status', (status.includes(s) ? status.filter((x) => x !== s) : [...status, s]).join(','));

  const workflows = useWorkflows();
  const query = useExecutionPages({
    workflowId: workflowId || undefined,
    status: status.length ? status : undefined,
    mode: (mode || undefined) as ExecutionMode | undefined,
    from: dayStart(from),
    to: dayEnd(to),
    limit: 50,
  });
  const remove = useDeleteExecutions();
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? 0;
  const filtered = Boolean(workflowId || status.length || mode || from || to);
  const deletable = items.filter((e) => !['queued', 'running', 'waiting'].includes(e.status));
  const allSelected = deletable.length > 0 && deletable.every((e) => selected.has(e.id));

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="animate-fade-in" data-testid="executions-page">
      <PageHeader
        title="Historique des exécutions"
        subtitle={query.data ? `${plural(total, 'execution')}${filtered ? ' match the filters' : ''}` : 'Retrouve chaque exécution et ses résultats'}
        actions={
          <div className="flex gap-2">
            {selected.size > 0 && (
              <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => setConfirm(true)} data-testid="executions-delete-selected">
                Delete {selected.size}
              </Button>
            )}
            <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={() => void query.refetch()} data-testid="executions-refresh">
              Refresh
            </Button>
          </div>
        }
      />
      <div className="flex flex-col gap-4 px-8 py-5">
        <div className="flex flex-wrap items-center gap-3" data-testid="executions-filters">
          <select className={selectCls} value={workflowId} onChange={(e) => setParam('workflowId', e.target.value)} aria-label="Workflow" data-testid="filter-workflow">
            <option value="">All workflows</option>
            {workflows.data?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <select className={selectCls} value={mode} onChange={(e) => setParam('mode', e.target.value)} aria-label="Mode" data-testid="filter-mode">
            <option value="">All modes</option>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-[12px] text-subtle">
            From
            <input type="date" className={selectCls} value={from} onChange={(e) => setParam('from', e.target.value)} data-testid="filter-from" />
          </label>
          <label className="flex items-center gap-1.5 text-[12px] text-subtle">
            To
            <input type="date" className={selectCls} value={to} onChange={(e) => setParam('to', e.target.value)} data-testid="filter-to" />
          </label>
          {filtered && (
            <Button variant="ghost" size="sm" onClick={() => { setParams({}, { replace: true }); setSelected(new Set()); }} data-testid="filter-clear">
              Clear filters
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5" data-testid="filter-status">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status.includes(s)}
              data-testid={`filter-status-${s}`}
              onClick={() => toggleStatus(s)}
              className={cn('rounded-full border px-3 py-1 text-[12px] capitalize', status.includes(s) ? 'border-accent bg-accent/15 text-fg' : 'border-line text-subtle hover:text-fg')}
            >
              {s}
            </button>
          ))}
        </div>

        {query.isError && <Alert>Could not load executions: {errorMessage(query.error)} <button className="underline" onClick={() => void query.refetch()}>Try again</button></Alert>}
        {query.isLoading ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : !query.isError && items.length === 0 ? (
          <Card className="flex flex-col items-center gap-2 py-14 text-center" data-testid="executions-empty">
            <History size={28} className="text-subtle" />
            <p className="text-[14px] font-medium">{filtered ? 'No executions match these filters' : 'No executions yet'}</p>
            <p className="text-[13px] text-muted">{filtered ? 'Try removing a filter.' : 'Run a workflow and it will show up here.'}</p>
          </Card>
        ) : (
          items.length > 0 && (
            <Card className="overflow-hidden p-0">
              <table className="w-full text-left text-[13px]" data-testid="executions-table">
                <thead className="border-b border-line text-[12px] text-subtle">
                  <tr>
                    <th className="w-10 px-4 py-2.5">
                      <input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(deletable.map((e) => e.id)))} data-testid="executions-select-all" />
                    </th>
                    <th className="px-2 py-2.5">Status</th>
                    <th className="px-2 py-2.5">Workflow</th>
                    <th className="px-2 py-2.5">Mode</th>
                    <th className="px-2 py-2.5">Started</th>
                    <th className="px-2 py-2.5">Duration</th>
                    <th className="px-2 py-2.5">ID</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => (
                    <Row key={e.id} e={e} checked={selected.has(e.id)} onToggle={() => toggle(e.id)} onOpen={() => navigate(`/executions/${e.id}`)} />
                  ))}
                </tbody>
              </table>
            </Card>
          )
        )}
        {query.hasNextPage && (
          <div className="flex justify-center">
            <Button variant="secondary" size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()} data-testid="executions-load-more">
              Load more ({items.length} of {total})
            </Button>
          </div>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title={`Delete ${plural(selected.size, 'execution')}?`}
          message="The stored data of these executions is removed for good. Running executions are skipped."
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            remove.mutate([...selected], {
              onSuccess: (r) => {
                toast.success(`Deleted ${plural(r.deleted, 'execution')}`);
                setSelected(new Set());
              },
              onError: (err) => toast.error('Could not delete', errorMessage(err)),
            });
          }}
        />
      )}
    </div>
  );
}

function Row({ e, checked, onToggle, onOpen }: { e: ExecutionListItem; checked: boolean; onToggle(): void; onOpen(): void }) {
  const active = ['queued', 'running', 'waiting'].includes(e.status);
  return (
    <tr className="cursor-pointer border-b border-line last:border-b-0 hover:bg-panel-2/60" onClick={onOpen} data-testid="execution-row" data-id={e.id} data-status={e.status}>
      <td className="px-4 py-3" onClick={(ev) => ev.stopPropagation()}>
        <input type="checkbox" aria-label={`Select execution ${e.id}`} disabled={active} checked={checked} onChange={onToggle} data-testid="execution-select" />
      </td>
      <td className="px-2 py-3"><StatusBadge status={e.status} /></td>
      <td className="px-2 py-3" onClick={(ev) => ev.stopPropagation()}>
        {e.workflowId ? <Link to={`/workflow/${e.workflowId}`} className="font-medium hover:text-accent-hover">{e.workflowName}</Link> : <span className="font-medium">{e.workflowName}</span>}
      </td>
      <td className="px-2 py-3 text-muted">{e.mode}</td>
      <td className="px-2 py-3 text-muted" title={e.startedAt ?? e.createdAt}>{timeAgo(e.startedAt ?? e.createdAt)}</td>
      <td className="px-2 py-3 text-muted">{duration(e.durationMs) || '-'}</td>
      <td className="px-2 py-3 font-mono text-[12px] text-subtle">#{e.id}</td>
    </tr>
  );
}
