import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Copy, Download, FileDown, FileUp, LayoutTemplate, Pencil, Plus, Search, Star, Tag as TagIcon, Trash2, Workflow, X } from 'lucide-react';
import type { WorkflowRecord, WorkflowSummary } from '@flowforge/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { api, errorMessage } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useFavorites } from '../lib/favorites';
import { toast } from '../lib/toast';
import { useTitle } from '../lib/useTitle';
import { cn } from '../components/ui/cn';
import { wsClient } from '../lib/ws';
import {
  downloadWorkflowExport,
  useBulkDelete,
  useCreateWorkflow,
  useDeleteWorkflow,
  useDuplicateWorkflow,
  useRenameWorkflow,
  useTags,
  useToggleActive,
  useWorkflows,
  workflowsKey,
} from '../lib/workflows-api';
import { ImportDialog, TagManager, TagPicker } from './workflows/Dialogs';
import { filterWorkflows, readFilters, statusDot, writeFilters, type ActiveFilter, type SortKey } from './workflows/filter';
import { PageHeader } from './PageHeader';

function Row({ wf, selected, onSelect }: { wf: WorkflowSummary; selected: boolean; onSelect(on: boolean): void }) {
  const favorites = useFavorites();
  const favorite = favorites.ids.includes(wf.id);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(wf.name);
  const [confirm, setConfirm] = useState(false);
  const rename = useRenameWorkflow();
  const remove = useDeleteWorkflow();
  const toggle = useToggleActive();
  const duplicate = useDuplicateWorkflow();
  const [picking, setPicking] = useState(false);
  const dot = statusDot(wf.lastExecutionStatus);
  const problem = wf.active ? wf.triggerError : wf.activationError;
  const commit = () => {
    setRenaming(false);
    if (name.trim() && name.trim() !== wf.name) {
      rename.mutate({ id: wf.id, name: name.trim() }, { onError: (err) => toast.error('Could not rename', errorMessage(err)) });
    } else setName(wf.name);
  };
  return (
    <div className="group flex flex-wrap items-center gap-3 border-b border-line px-4 py-4 last:border-b-0 hover:bg-panel-2/60" data-testid="workflow-row" data-name={wf.name}>
      <input type="checkbox" aria-label={`Select ${wf.name}`} data-testid="workflow-select" checked={selected} onChange={(e) => onSelect(e.target.checked)} className="size-4 shrink-0 accent-[var(--color-accent)]" />
      <button type="button" aria-label={favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'} aria-pressed={favorite} data-testid="workflow-favorite" onClick={() => favorites.toggle(wf.id)} className={cn('shrink-0 rounded p-1.5 transition-colors hover:bg-panel-3', favorite ? 'text-amber-300' : 'text-subtle hover:text-amber-300')}>
        <Star size={16} fill={favorite ? 'currentColor' : 'none'} />
      </button>
      <span className={cn('size-2.5 shrink-0 rounded-full', dot.cls)} title={dot.label + (wf.lastExecutionAt ? ` · ${timeAgo(wf.lastExecutionAt)}` : '')} data-testid="workflow-status-dot" data-status={wf.lastExecutionStatus ?? 'none'} />
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            data-testid="workflow-rename-input"
            className="h-8 w-full max-w-md rounded border border-accent bg-panel-2 px-2 text-[14px] focus:outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setName(wf.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <Link to={`/workflow/${wf.id}`} className="block truncate text-[14px] font-medium hover:text-accent-hover" data-testid="workflow-link">
            {wf.name}
          </Link>
        )}
        <div className="text-[12px] text-subtle">
          {wf.nodeCount} étape{wf.nodeCount === 1 ? '' : 's'} · modifié {timeAgo(wf.updatedAt)} · créé le {new Date(wf.createdAt).toLocaleDateString('fr-FR')}
        </div>
        {wf.tags && wf.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1" data-testid="workflow-tags">
            {wf.tags.map((t) => (
              <span key={t.id} className="rounded-full border border-line-strong bg-panel-3 px-2 py-px text-[11px] text-muted" data-testid="workflow-tag">
                {t.name}
              </span>
            ))}
          </div>
        )}
        {problem && (
          <div className="truncate text-[12px] text-danger" data-testid="workflow-row-error" title={problem}>
            {problem}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2" title={problem ?? undefined}>
        <span className={cn('text-[12px]', wf.active ? (wf.triggerError ? 'text-danger' : 'text-success') : 'text-subtle')} data-testid="workflow-row-status">
          {wf.active ? 'Actif' : 'Inactif'}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={wf.active}
          aria-label={wf.active ? 'Désactiver' : 'Activer'}
          data-testid="workflow-row-toggle"
          disabled={toggle.isPending}
          onClick={() =>
            toggle.mutate(
              { id: wf.id, active: !wf.active },
              {
                onSuccess: () => toast.success(wf.active ? 'Workflow deactivated' : 'Workflow activated'),
                onError: (err) => toast.error('Could not activate the workflow', errorMessage(err)),
              },
            )
          }
          className={cn('relative h-5 w-9 rounded-full transition-colors disabled:opacity-50', wf.active ? 'bg-success' : 'bg-line-strong')}
        >
          <span className={cn('absolute top-0.5 size-4 rounded-full bg-white transition-all', wf.active ? 'left-[18px]' : 'left-0.5')} />
        </button>
      </div>
      <div className="flex gap-1 opacity-80 group-hover:opacity-100">
        <button
          type="button"
          title="Dupliquer"
          data-testid="workflow-duplicate"
          disabled={duplicate.isPending}
          onClick={() =>
            duplicate.mutate(wf.id, {
              onSuccess: (copy) => toast.success('Workflow duplicated', `"${copy.name}" was created.`),
              onError: (err) => toast.error('Could not duplicate', errorMessage(err)),
            })
          }
          className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-fg disabled:opacity-50"
        >
          <Copy size={15} />
        </button>
        <button
          type="button"
          title="Exporter en JSON"
          data-testid="workflow-export"
          onClick={() => downloadWorkflowExport(wf.id, wf.name).catch((err) => toast.error('Could not export', errorMessage(err)))}
          className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-fg"
        >
          <FileDown size={15} />
        </button>
        <button type="button" title="Tags" data-testid="workflow-tags-edit" onClick={() => setPicking(true)} className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-fg">
          <TagIcon size={15} />
        </button>
        <button type="button" title="Renommer" data-testid="workflow-rename" onClick={() => setRenaming(true)} className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-fg">
          <Pencil size={15} />
        </button>
        <button type="button" title="Supprimer" data-testid="workflow-delete" onClick={() => setConfirm(true)} className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-danger">
          <Trash2 size={15} />
        </button>
      </div>
      {picking && <TagPicker workflowId={wf.id} name={wf.name} selected={(wf.tags ?? []).map((t) => t.id)} onClose={() => setPicking(false)} />}
      {confirm && (
        <ConfirmDialog
          title={`Delete "${wf.name}"?`}
          message="The workflow is deleted permanently. Its past executions stay in the history."
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            remove.mutate(wf.id, {
              onSuccess: () => toast.success('Workflow deleted'),
              onError: (err) => toast.error('Could not delete', errorMessage(err)),
            });
          }}
        />
      )}
    </div>
  );
}

interface ExampleInfo {
  id: string;
  name: string;
  description: string;
  nodeCount: number;
}

/** Ready-made workflows from the repo's `examples/` folder: one click creates a copy. */
function ExamplesDialog({ onClose }: { onClose(): void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const examples = useQuery({ queryKey: ['examples'], queryFn: () => api<ExampleInfo[]>('/examples') });
  const [importing, setImporting] = useState<string>();
  const importExample = (id: string) => {
    setImporting(id);
    api<WorkflowRecord>(`/examples/${id}/import`, { method: 'POST' })
      .then((wf) => {
        void client.invalidateQueries({ queryKey: workflowsKey });
        toast.success('Example imported', `"${wf.name}" is ready to edit.`);
        navigate(`/workflow/${wf.id}`);
      })
      .catch((err) => toast.error('Could not import the example', errorMessage(err)))
      .finally(() => setImporting(undefined));
  };
  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[86vh] w-[620px] max-w-[94vw] animate-fade-in flex-col overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl" role="dialog" aria-label="Examples" data-testid="examples-dialog">
        <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <LayoutTemplate size={18} className="text-accent-hover" />
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold">Exemples de workflows</h2>
            <p className="text-[12px] text-subtle">Chaque exemple crée une copie que tu peux adapter à tes besoins.</p>
          </div>
          <button type="button" onClick={onClose} title="Close" className="rounded p-1.5 text-subtle hover:bg-panel-3 hover:text-fg">
            <X size={16} />
          </button>
        </header>
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-4">
          {examples.isPending ? (
            <Spinner />
          ) : examples.isError ? (
            <Alert>{errorMessage(examples.error)}</Alert>
          ) : examples.data.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-subtle">No example found in the examples/ folder.</p>
          ) : (
            examples.data.map((e) => (
              <div key={e.id} className="flex items-center gap-4 rounded-lg border border-line bg-panel-2/60 px-4 py-3" data-testid="example-row" data-id={e.id}>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium">{e.name}</div>
                  <div className="text-[12.5px] text-muted">{e.description}</div>
                  <div className="mt-0.5 text-[11.5px] text-subtle">
                    {e.nodeCount} node{e.nodeCount === 1 ? '' : 's'}
                  </div>
                </div>
                <Button size="sm" icon={<Download size={14} />} loading={importing === e.id} onClick={() => importExample(e.id)} data-testid={`import-example-${e.id}`}>
                  Importer
                </Button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

const SELECT = 'h-9 rounded-md border border-line-strong bg-panel-2 px-2 text-[13px] focus:border-accent focus:outline-none';

export function WorkflowsPage() {
  useTitle('Workflows');
  const client = useQueryClient();
  // Activation changes (also from other tabs or trigger failures) refresh the list.
  useEffect(
    () =>
      wsClient.onEvent((e) => {
        if (e.type.startsWith('workflow.') || e.type.startsWith('execution.')) void client.invalidateQueries({ queryKey: workflowsKey });
      }),
    [client],
  );
  const navigate = useNavigate();
  const workflows = useWorkflows();
  const tags = useTags();
  const create = useCreateWorkflow();
  const bulk = useBulkDelete();
  const [examples, setExamples] = useState(false);
  const [importing, setImporting] = useState(false);
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [params, setParams] = useSearchParams();
  const favorites = useFavorites();
  // Local state is the source of truth (always current); the URL mirrors it. React Router's functional
  // setSearchParams reads the params of the last render, so two quick changes would lose the first one.
  const [filters, setFilterState] = useState(() => readFilters(params));
  useEffect(() => {
    setParams(writeFilters(filters), { replace: true });
  }, [filters, setParams]);
  const setFilters = (patch: Partial<typeof filters>) => setFilterState((f) => ({ ...f, ...patch }));
  const visible = useMemo(() => (workflows.data ? filterWorkflows(workflows.data, filters).filter((w) => !filters.favorites || favorites.ids.includes(w.id)) : []), [workflows.data, filters, favorites.ids]);
  const filtering = filters.q !== '' || filters.tags.length > 0 || filters.active !== 'all' || filters.favorites;
  // Selection only keeps workflows that still exist.
  const selectedIds = visible.filter((w) => selected.has(w.id)).map((w) => w.id);
  const allSelected = visible.length > 0 && selectedIds.length === visible.length;
  const createAndOpen = () =>
    create.mutate(
      {},
      {
        onSuccess: (wf) => navigate(`/workflow/${wf.id}`),
        onError: (err) => toast.error('Could not create the workflow', errorMessage(err)),
      },
    );

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Mes workflows"
        subtitle="Ton espace pour créer, organiser et automatiser."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<FileUp size={16} />} onClick={() => setImporting(true)} data-testid="open-import">
              Importer
            </Button>
            <Button variant="secondary" icon={<LayoutTemplate size={16} />} onClick={() => setExamples(true)} data-testid="open-examples">
              Exemples
            </Button>
            <Button icon={<Plus size={16} />} loading={create.isPending} onClick={createAndOpen} data-testid="create-workflow">
              Nouveau workflow
            </Button>
          </div>
        }
      />
      {examples && <ExamplesDialog onClose={() => setExamples(false)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {managing && <TagManager onClose={() => setManaging(false)} />}
      {confirmBulk && (
        <ConfirmDialog
          title={`Delete ${selectedIds.length} workflow${selectedIds.length === 1 ? '' : 's'}?`}
          message="The selected workflows are deleted permanently. Their past executions stay in the history."
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmBulk(false)}
          onConfirm={() => {
            setConfirmBulk(false);
            bulk.mutate(selectedIds, {
              onSuccess: (res) => {
                setSelected(new Set());
                toast.success(`${res.deleted} workflow${res.deleted === 1 ? '' : 's'} deleted`);
              },
              onError: (err) => toast.error('Could not delete', errorMessage(err)),
            });
          }}
        />
      )}
      <div className="px-8 py-6">
        {workflows.isPending ? (
          <Spinner />
        ) : workflows.isError ? (
          <Alert>{errorMessage(workflows.error)}</Alert>
        ) : workflows.data.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <div className="grid size-14 place-items-center rounded-2xl border border-line bg-panel-2 text-accent-hover">
              <Workflow size={26} />
            </div>
            <h2 className="text-base font-semibold">Tes idées commencent ici.</h2>
            <p className="max-w-sm text-muted">Un déclencheur, quelques étapes : construis ta première automatisation ou choisis un exemple.</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button icon={<Plus size={16} />} onClick={createAndOpen} loading={create.isPending}>
                Créer mon premier workflow
              </Button>
              <Button variant="secondary" icon={<LayoutTemplate size={16} />} onClick={() => setExamples(true)}>
                Partir d'un exemple
              </Button>
              <Button variant="secondary" icon={<FileUp size={16} />} onClick={() => setImporting(true)}>
                Importer un fichier
              </Button>
            </div>
          </Card>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="workflow-filters">
              <Button variant={filters.favorites ? 'primary' : 'secondary'} size="sm" icon={<Star size={14} />} aria-pressed={filters.favorites} onClick={() => setFilters({ favorites: !filters.favorites })} data-testid="favorites-filter">Favoris</Button>
              <div className="relative">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
                <input
                  data-testid="workflow-search"
                  value={filters.q}
                  onChange={(e) => setFilters({ q: e.target.value })}
                  placeholder="Rechercher par nom ou tag"
                  className="h-9 w-64 rounded-md border border-line-strong bg-panel-2 pl-8 pr-3 text-[13px] focus:border-accent focus:outline-none"
                />
              </div>
              <select aria-label="Status filter" data-testid="filter-active" className={SELECT} value={filters.active} onChange={(e) => setFilters({ active: e.target.value as ActiveFilter })}>
                <option value="all">Tous</option>
                <option value="active">Actifs</option>
                <option value="inactive">Inactifs</option>
              </select>
              <select aria-label="Sort" data-testid="filter-sort" className={SELECT} value={filters.sort} onChange={(e) => setFilters({ sort: e.target.value as SortKey })}>
                <option value="updated">Dernière modification</option>
                <option value="created">Plus récents</option>
                <option value="name">Nom A-Z</option>
              </select>
              <Button variant="ghost" size="sm" icon={<TagIcon size={14} />} onClick={() => setManaging(true)} data-testid="manage-tags">
                Gérer les tags
              </Button>
              {filtering && (
                <Button variant="ghost" size="sm" icon={<X size={14} />} onClick={() => setFilters({ q: '', tags: [], active: 'all', favorites: false })} data-testid="clear-filters">
                  Effacer les filtres
                </Button>
              )}
            </div>
            {tags.data && tags.data.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1.5" data-testid="tag-filter">
                {tags.data.map((t) => {
                  const on = filters.tags.includes(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={on}
                      data-testid="tag-chip"
                      data-name={t.name}
                      onClick={() => setFilters({ tags: on ? filters.tags.filter((x) => x !== t.id) : [...filters.tags, t.id] })}
                      className={cn('rounded-full border px-2.5 py-0.5 text-[12px] transition-colors', on ? 'border-accent bg-accent/20 text-accent-hover' : 'border-line-strong text-muted hover:text-fg')}
                    >
                      {t.name} <span className="text-subtle">{t.usageCount ?? 0}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {selectedIds.length > 0 && (
              <div className="mb-3 flex items-center gap-3 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2 text-[13px]" data-testid="bulk-bar">
                <span>{selectedIds.length} selected</span>
                <Button variant="danger" size="sm" icon={<Trash2 size={14} />} loading={bulk.isPending} onClick={() => setConfirmBulk(true)} data-testid="bulk-delete">
                  Supprimer la sélection
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
                  Annuler la sélection
                </Button>
              </div>
            )}
            {visible.length === 0 ? (
              <Card className="px-6 py-12 text-center" data-testid="no-results">
                <p className="text-[14px] font-medium">Aucun workflow trouvé</p>
                <p className="mt-1 text-[13px] text-muted">Modifie ta recherche ou efface les filtres.</p>
              </Card>
            ) : (
              <Card data-testid="workflow-list">
                <div className="flex items-center gap-4 border-b border-line px-5 py-2 text-[12px] text-subtle">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    data-testid="workflow-select-all"
                    checked={allSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(visible.map((w) => w.id)) : new Set())}
                    className="size-4 accent-[var(--color-accent)]"
                  />
                  <span>
                    {visible.length} workflow{visible.length === 1 ? '' : 's'}
                    {filtering ? ` of ${workflows.data.length}` : ''}
                  </span>
                </div>
                {visible.map((wf) => (
                  <Row
                    key={wf.id}
                    wf={wf}
                    selected={selected.has(wf.id)}
                    onSelect={(on) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (on) next.add(wf.id);
                        else next.delete(wf.id);
                        return next;
                      })
                    }
                  />
                ))}
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
