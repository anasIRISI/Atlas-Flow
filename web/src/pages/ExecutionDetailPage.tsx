import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, ExternalLink, History, RotateCcw, Trash2 } from 'lucide-react';
import type { ExecutionDetail, Item, NodeRun } from '@flowforge/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Spinner } from '../components/ui/Spinner';
import { DataView, hasBinary, savedView, ViewSwitch, type ViewMode } from '../editor/ndv/DataView';
import { ErrorCard } from '../editor/ndv/ErrorCard';
import { errorMessage } from '../lib/api';
import { useDeleteExecutions, useExecution, useRetryExecution } from '../lib/executions-api';
import { duration, plural } from '../lib/format';
import { toast } from '../lib/toast';
import { useTitle } from '../lib/useTitle';
import { PageHeader } from './PageHeader';
import { StatusBadge } from './ExecutionsPage';

interface Entry {
  key: string;
  node: string;
  runIndex: number;
  run: NodeRun;
}

/** Every node run in the order it happened. */
function entriesOf(detail: ExecutionDetail): Entry[] {
  const out: Entry[] = [];
  for (const [node, runs] of Object.entries(detail.runData)) runs.forEach((run, runIndex) => out.push({ key: `${node}#${runIndex}`, node, runIndex, run }));
  return out.sort((a, b) => a.run.startTime - b.run.startTime || a.node.localeCompare(b.node));
}

const count = (run: NodeRun) => run.data.main.reduce((n, list) => n + list.length, 0);

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide text-subtle">{label}</span>
      <span className="text-[13px]">{children}</span>
    </div>
  );
}

function DataPane({ title, testId, tabs, items, draggable }: { title: string; testId: string; tabs?: string[]; items: Item[][]; draggable?: boolean }) {
  const [tab, setTab] = useState(0);
  const [view, setView] = useState<ViewMode>(savedView());
  const list = items[Math.min(tab, Math.max(items.length - 1, 0))] ?? [];
  return (
    <section className="flex min-h-[220px] min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-panel" data-testid={testId}>
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2 text-[12.5px] font-semibold uppercase tracking-wide text-muted">
          {title}
          <span className="font-normal normal-case text-subtle" data-testid={`${testId}-count`}>{plural(list.length, 'item')}</span>
        </div>
        <ViewSwitch view={view} onChange={setView} binary={hasBinary(list)} />
      </header>
      {items.length > 1 && (
        <div className="flex gap-1 border-b border-line px-3 py-1.5">
          {items.map((_, i) => (
            <button key={i} type="button" onClick={() => setTab(i)} className={cn('rounded px-2 py-0.5 text-[12px]', tab === i ? 'bg-panel-3 text-fg' : 'text-subtle hover:text-fg')}>
              {tabs?.[i] ?? `Output ${i}`}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {list.length === 0 ? <div className="p-4 text-[12.5px] text-subtle">No data</div> : <DataView items={list} view={view} draggable={draggable ?? false} />}
      </div>
    </section>
  );
}

export function ExecutionDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const query = useExecution(id);
  const detail = query.data;
  useTitle(detail ? `Execution #${detail.id}` : 'Execution');
  const retry = useRetryExecution();
  const remove = useDeleteExecutions();
  const [picked, setPicked] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const entries = useMemo(() => (detail ? entriesOf(detail) : []), [detail]);
  const active = entries.find((e) => e.key === picked) ?? entries.find((e) => e.run.status === 'error') ?? entries[entries.length - 1];

  if (query.isLoading) return <div className="flex justify-center py-24"><Spinner /></div>;
  if (query.isError || !detail) {
    return (
      <div className="animate-fade-in p-8" data-testid="execution-error">
        <Alert>{errorMessage(query.error)}</Alert>
        <Link to="/executions" className="mt-4 inline-flex items-center gap-1.5 text-[13px] text-accent-hover"><ArrowLeft size={14} /> Back to executions</Link>
      </div>
    );
  }

  const retryOf = (detail as { retryOf?: string | null }).retryOf;
  const failed = ['error', 'crashed', 'canceled'].includes(detail.status);
  const startedAt = detail.startedAt ? Date.parse(detail.startedAt) : null;
  const stoppedAt = detail.stoppedAt ? Date.parse(detail.stoppedAt) : null;
  const isActive = ['queued', 'running', 'waiting'].includes(detail.status);

  const doRetry = (fromFailedNode: boolean) =>
    retry.mutate(
      { id: detail.id, fromFailedNode },
      {
        onSuccess: (r) => {
          toast.success('Retry started');
          navigate(`/executions/${r.executionId}`);
        },
        onError: (err) => toast.error('Could not retry', errorMessage(err)),
      },
    );

  // INPUT = what the node received; OUTPUT = what it sent on.
  let input: Item[][] = [];
  let inputTabs: string[] = [];
  if (active) {
    active.run.source.forEach((src, i) => {
      if (!src) return;
      input.push(detail.runData[src.previousNode]?.[src.previousNodeRun]?.data.main[src.previousNodeOutput] ?? []);
      inputTabs.push(`From ${src.previousNode}${active.run.source.length > 1 ? ` (input ${i + 1})` : ''}`);
    });
  }
  const trigger = active && active.run.source.length === 0;

  return (
    <div className="animate-fade-in" data-testid="execution-detail">
      <PageHeader
        title={`Execution #${detail.id}`}
        subtitle={
          <span className="inline-flex items-center gap-2">
            <Link to="/executions" className="inline-flex items-center gap-1 hover:text-fg"><ArrowLeft size={13} /> All executions</Link>
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {failed && detail.error?.node && (
              <Button size="sm" icon={<RotateCcw size={14} />} loading={retry.isPending} onClick={() => doRetry(true)} data-testid="retry-failed">
                Retry from failed node
              </Button>
            )}
            {failed && (
              <Button size="sm" variant="secondary" icon={<RotateCcw size={14} />} disabled={retry.isPending} onClick={() => doRetry(false)} data-testid="retry-all">
                Retry from start
              </Button>
            )}
            {detail.workflowId && (
              <Button size="sm" variant="secondary" icon={<ExternalLink size={14} />} onClick={() => navigate(`/workflow/${detail.workflowId}?execution=${detail.id}`)} data-testid="open-in-editor">
                Open workflow
              </Button>
            )}
            {detail.workflowId && !isActive && (
              <Button size="sm" variant="secondary" icon={<History size={14} />} onClick={() => navigate(`/workflow/${detail.workflowId}?execution=${detail.id}&replay=1`)} data-testid="time-travel">
                Time travel
              </Button>
            )}
            <Button size="sm" variant="danger" icon={<Trash2 size={14} />} disabled={isActive} title={isActive ? 'Stop it first' : undefined} onClick={() => setConfirm(true)} data-testid="execution-delete">
              Delete
            </Button>
          </div>
        }
      />
      <div className="flex flex-col gap-4 px-8 py-5">
        <Card className="flex flex-wrap gap-x-8 gap-y-3 p-4" data-testid="execution-meta">
          <Meta label="Status"><StatusBadge status={detail.status} /></Meta>
          <Meta label="Workflow">{detail.workflowId ? <Link className="hover:text-accent-hover" to={`/workflow/${detail.workflowId}`}>{detail.workflowName}</Link> : detail.workflowName}</Meta>
          <Meta label="Mode">{detail.mode}</Meta>
          <Meta label="Started">{detail.startedAt ? new Date(detail.startedAt).toLocaleString() : '-'}</Meta>
          <Meta label="Duration">{startedAt && stoppedAt ? duration(stoppedAt - startedAt) : '-'}</Meta>
          {retryOf && <Meta label="Retry of"><Link data-testid="retry-of" className="hover:text-accent-hover" to={`/executions/${retryOf}`}>#{retryOf}</Link></Meta>}
          {detail.parentExecutionId && <Meta label="Parent"><Link className="hover:text-accent-hover" to={`/executions/${detail.parentExecutionId}`}>#{detail.parentExecutionId}</Link></Meta>}
        </Card>
        {failed && detail.error && !active?.run.error && <Alert>{detail.error.message}</Alert>}

        {entries.length === 0 ? (
          <Card className="py-12 text-center text-[13px] text-muted" data-testid="execution-no-data">
            {isActive ? 'This execution has not produced any data yet.' : 'No node data was stored for this execution.'}
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
            <Card className="h-fit overflow-hidden p-0" data-testid="execution-nodes">
              <div className="border-b border-line px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Nodes</div>
              <ul>
                {entries.map((e) => (
                  <li key={e.key}>
                    <button
                      type="button"
                      onClick={() => setPicked(e.key)}
                      data-testid="execution-node"
                      data-node={e.node}
                      data-status={e.run.status}
                      className={cn('flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-[13px] last:border-b-0 hover:bg-panel-2', active?.key === e.key && 'bg-panel-3')}
                    >
                      <span className={cn('size-2 shrink-0 rounded-full', e.run.status === 'error' ? 'bg-danger' : e.run.status === 'success' ? 'bg-success' : 'bg-subtle')} />
                      <span className="min-w-0 flex-1 truncate">{e.node}{e.runIndex > 0 ? ` (run ${e.runIndex + 1})` : ''}</span>
                      <span className="shrink-0 text-[11.5px] text-subtle">{e.run.status === 'reused' ? 'reused' : plural(count(e.run), 'item')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
            {active && (
              <div className="flex min-w-0 flex-col gap-3" data-testid="execution-node-data" data-node={active.node}>
                <div className="flex items-baseline gap-3">
                  <h2 className="text-[15px] font-semibold">{active.node}</h2>
                  <span className="text-[12px] text-subtle">{active.run.status} · {duration(active.run.executionTime)}</span>
                </div>
                {active.run.error && (
                  <div className="rounded-lg border border-line bg-panel"><ErrorCard error={active.run.error} /></div>
                )}
                <div className="flex flex-col gap-3 xl:flex-row">
                  {trigger ? (
                    <section className="flex min-w-[200px] items-center justify-center rounded-lg border border-line bg-panel p-4 text-[12.5px] text-subtle xl:w-56" data-testid="execution-input">
                      Trigger: no input
                    </section>
                  ) : (
                    <DataPane title="Input" testId="execution-input" tabs={inputTabs} items={input.length ? input : [[]]} />
                  )}
                  <DataPane title="Output" testId="execution-output" tabs={active.run.data.main.map((_, i) => `Output ${i}`)} items={active.run.data.main.length ? active.run.data.main : [[]]} />
                </div>
                {active.run.logs?.length ? <pre className="overflow-auto rounded-lg border border-line bg-panel p-3 font-mono text-[12px] text-muted">{active.run.logs.join('\n')}</pre> : null}
              </div>
            )}
          </div>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title={`Delete execution #${detail.id}?`}
          message="Its stored data is removed for good."
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            remove.mutate([detail.id], {
              onSuccess: () => {
                toast.success('Execution deleted');
                navigate('/executions');
              },
              onError: (err) => toast.error('Could not delete', errorMessage(err)),
            });
          }}
        />
      )}
    </div>
  );
}
