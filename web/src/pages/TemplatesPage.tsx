import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { KeyRound, Search } from 'lucide-react';
import type { TemplateCategory, TemplateDetail, TemplateInfo, WorkflowRecord } from '@flowforge/shared';
import { GraphPreview } from '../components/GraphPreview';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Spinner } from '../components/ui/Spinner';
import { api, errorMessage } from '../lib/api';
import { iconFor, useNodeTypes } from '../lib/node-types';
import { toast } from '../lib/toast';
import { useTitle } from '../lib/useTitle';
import { PageHeader } from './PageHeader';

const CATEGORIES: TemplateCategory[] = ['AI', 'Forms', 'Email', 'Messaging', 'Data', 'Scheduling', 'Webhooks', 'Utilities'];

function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value);
  const [last, setLast] = useState(value);
  if (last !== value) {
    setLast(value);
    setTimeout(() => setV(value), ms);
  }
  return v;
}

function TemplateCard({ t, onUse, busy }: { t: TemplateInfo; onUse: () => void; busy: boolean }) {
  const types = useNodeTypes();
  // The graph preview needs positions: fetched when the card is shown.
  const detail = useQuery({ queryKey: ['template', t.id], queryFn: () => api<TemplateDetail>(`/templates/${encodeURIComponent(t.id)}`), staleTime: 300_000 });
  const colors: Record<string, string> = {};
  for (const type of t.nodeTypes) {
    const c = types.data?.byType.get(type)?.defaults?.color;
    if (c) colors[type] = c;
  }
  return (
    <Card className="flex flex-col overflow-hidden" data-testid="template-card" data-template-id={t.id}>
      <div className="h-32 border-b border-line bg-panel-2">
        {detail.data ? <GraphPreview nodes={detail.data.nodes} connections={detail.data.connections} colors={colors} /> : <div className="grid h-full place-items-center"><Spinner /></div>}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <h3 className="text-[14px] font-semibold leading-snug">{t.name}</h3>
          <p className="mt-1 line-clamp-3 text-[12.5px] text-muted">{t.description}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {t.nodeTypes.slice(0, 7).map((type) => {
            const info = types.data?.byType.get(type);
            const Icon = iconFor(info?.icon);
            return (
              <span key={type} title={info?.displayName ?? type} className="grid size-6 place-items-center rounded-md bg-panel-3 text-muted">
                <Icon size={13} />
              </span>
            );
          })}
          {t.nodeTypes.length > 7 && <span className="text-[11px] text-subtle">+{t.nodeTypes.length - 7}</span>}
          <span className="ml-auto text-[11px] text-subtle">{t.nodeCount} nodes</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {t.categories.map((c) => (
            <span key={c} className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">{c}</span>
          ))}
          {t.credentialTypes.length > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] text-subtle" title={`Needs: ${t.credentialTypes.join(', ')}`}>
              <KeyRound size={11} /> credentials
            </span>
          )}
        </div>
        <Button size="sm" className="mt-auto" onClick={onUse} loading={busy} data-testid="use-template">
          Utiliser ce modèle
        </Button>
      </div>
    </Card>
  );
}

/** Templates gallery: examples, ready-made templates and the AI builder's built-in ones. */
export function TemplatesPage() {
  useTitle('Modèles');
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<TemplateCategory | null>(null);
  const q = useDebounced(search.trim());

  const list = useQuery({
    queryKey: ['templates', q, category],
    queryFn: () => api<TemplateInfo[]>(`/templates?q=${encodeURIComponent(q)}${category ? `&category=${encodeURIComponent(category)}` : ''}`),
    placeholderData: (prev) => prev,
  });
  const use = useMutation({
    mutationFn: (id: string) => api<WorkflowRecord>(`/templates/${encodeURIComponent(id)}/import`, { method: 'POST', body: {} }),
    onSuccess: (wf) => {
      toast.success(`Imported "${wf.name}"`);
      navigate(`/workflow/${wf.id}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="animate-fade-in">
      <PageHeader title="La bonne idée, déjà prête." subtitle="Choisis un modèle, adapte-le et fais-le tourner." />
      <div className="flex flex-col gap-5 px-8 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full max-w-sm">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher un modèle…"
              aria-label="Search templates"
              data-testid="template-search"
              className="h-9 w-full rounded-md border border-line-strong bg-panel-2 pl-9 pr-3 text-[13px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categories">
            {[null, ...CATEGORIES].map((c) => (
              <button
                key={c ?? 'all'}
                onClick={() => setCategory(c)}
                aria-pressed={category === c}
                data-testid={`template-category-${c ?? 'all'}`}
                className={cn('rounded-full border px-3 py-1 text-[12.5px] transition-colors', category === c ? 'border-accent bg-accent-soft text-accent' : 'border-line-strong text-muted hover:text-fg')}
              >
                {c ?? 'Tous'}
              </button>
            ))}
          </div>
        </div>

        {list.isError && <Alert>Could not load the templates: {errorMessage(list.error)}</Alert>}
        {list.isLoading && (
          <div className="flex justify-center py-16"><Spinner /></div>
        )}
        {list.data && list.data.length === 0 && (
          <Card className="p-10 text-center text-[13px] text-muted" data-testid="templates-empty">Aucun modèle ne correspond à ta recherche.</Card>
        )}
        {list.data && list.data.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {list.data.map((t) => (
              <TemplateCard key={t.id} t={t} onUse={() => use.mutate(t.id)} busy={use.isPending && use.variables === t.id} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
