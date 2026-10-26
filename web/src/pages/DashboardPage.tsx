import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Activity, ArrowRight, BookOpen, CircleCheck, Clock, Play, Plug, Sparkles, Workflow, Zap } from 'lucide-react';
import { Alert } from '../components/ui/Alert';
import { Card } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Spinner } from '../components/ui/Spinner';
import { errorMessage } from '../lib/api';
import { Button } from '../components/ui/Button';
import { useCreateWorkflow } from '../lib/workflows-api';
import { starterWorkflow } from '../lib/starter-workflow';
import { toast } from '../lib/toast';
import { useAuthStatus } from '../lib/auth';
import { duration, plural, timeAgo } from '../lib/format';
import { startDemo, useDemo } from '../demo/demo-store';
import { useTitle } from '../lib/useTitle';
import { StatusBadge } from './ExecutionsPage';
import { PageHeader } from './PageHeader';
import { useDashboard } from './dashboard/dashboard-api';
import { RunsChart } from './dashboard/RunsChart';
import { SystemCards } from './dashboard/SystemCards';

function Kpi({ icon, label, value, hint, testId }: { icon: ReactNode; label: string; value: string; hint?: string; testId: string }) {
  return (
    <Card className="p-5" data-testid={testId}>
      <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-wide text-subtle">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-[28px] font-semibold leading-none tracking-tight">{value}</div>
      {hint && <div className="mt-2 text-[12px] text-muted">{hint}</div>}
    </Card>
  );
}

function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('p-5', className)}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

const linkCls = 'text-[13px] text-accent hover:text-accent-hover';

/** Overview: instance cards, KPIs, runs per day, failing workflows, recent executions, integrations. */
export function DashboardPage() {
  useTitle('Tableau de bord');
  const auth = useAuthStatus();
  const q = useDashboard();
  const s = q.data;
  const name = auth.data?.user?.firstName;
  const navigate = useNavigate();
  const demoStarting = useDemo((d) => d.starting);
  const create = useCreateWorkflow();
  const start = () => create.mutate(starterWorkflow(name ?? ''), {
    onSuccess: (wf) => navigate(`/workflow/${wf.id}`),
    onError: (err) => toast.error('Création impossible', errorMessage(err)),
  });

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Tableau de bord"
        subtitle={`${name ? `Bonjour ${name}. ` : ''}Fais de la place pour ce qui compte.`}
        actions={
          <button
            onClick={() => void startDemo(navigate)}
            disabled={demoStarting}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60"
            data-testid="demo-mode-header-button"
          >
            <Play size={15} /> {demoStarting ? 'Chargement…' : 'Démo guidée'}
          </button>
        }
      />
      <div className="flex flex-col gap-6 px-8 py-6">
        <Card className="atlas-hero flex flex-wrap items-center justify-between gap-8 p-6 sm:p-8">
          <div className="relative z-10 max-w-xl">
            <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-teal-300"><Sparkles size={14} /> Ton atelier d’automatisation</div>
            <h2 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">Tes idées.<br /><span className="text-teal-300">En mouvement.</span></h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-muted">Connecte tes outils, simplifie tes tâches et construis tes propres automatisations. Une étape à la fois.</p>
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <Button icon={<Zap size={16} />} onClick={start} loading={create.isPending} data-testid="create-starter">Essayer mon premier flow</Button>
              <Link to="/guide" className="inline-flex items-center gap-2 text-sm text-muted hover:text-fg"><BookOpen size={16} /> Le guide rapide <ArrowRight size={14} /></Link>
            </div>
            <p className="mt-3 text-[11px] text-muted">Exemple personnel prêt à exécuter · Aucune clé API nécessaire</p>
          </div>
          <div aria-hidden="true" className="relative z-10 hidden items-center gap-3 pr-6 xl:flex">
            {[{ Icon: Play, text: 'Déclencher' }, { Icon: Workflow, text: 'Transformer' }, { Icon: CircleCheck, text: 'Accomplir' }].map(({ Icon, text }, i) => (
              <div key={text} className="flex items-center gap-3">
                {i > 0 && <span className="h-px w-5 bg-teal-400/40" />}
                <div className="flex w-24 flex-col items-center gap-3 rounded-2xl border border-sky-300/20 bg-bg/40 px-3 py-5 shadow-xl"><Icon size={25} className={i === 2 ? 'text-teal-300' : 'text-sky-300'} /><span className="text-[11px] text-muted">{text}</span></div>
              </div>
            ))}
          </div>
        </Card>

        {q.isError && <Alert>Impossible de charger le tableau de bord : {errorMessage(q.error)}</Alert>}
        {q.isLoading && (
          <div className="flex justify-center py-10" data-testid="dashboard-loading">
            <Spinner />
          </div>
        )}

        {s && (
          <>
            {s.workflows.total === 0 && (
              <Card className="p-5" data-testid="get-started">
                <div className="text-[15px] font-semibold">À toi de jouer</div>
                <p className="mt-0.5 text-[13px] text-muted">Pas encore de workflow. Choisis ton point de départ.</p>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <Link to="/templates" className="rounded-lg border border-line bg-panel-2 p-4 transition-colors hover:border-accent">
                    <div className="text-[13.5px] font-medium">1 · Choisir un modèle</div>
                    <div className="mt-1 text-[12.5px] text-muted">Formulaires, email, Telegram, IA… importe une base prête à adapter.</div>
                  </Link>
                  <Link to="/workflows" className="rounded-lg border border-line bg-panel-2 p-4 transition-colors hover:border-accent">
                    <div className="text-[13.5px] font-medium">2 · Construire une idée</div>
                    <div className="mt-1 text-[12.5px] text-muted">Mes workflows → Nouveau workflow : ajoute un déclencheur ou utilise la barre IA.</div>
                  </Link>
                  <button type="button" onClick={() => void startDemo(navigate)} disabled={demoStarting} className="rounded-lg border border-line bg-panel-2 p-4 text-left transition-colors hover:border-accent disabled:opacity-60">
                    <div className="text-[13.5px] font-medium">3 · Explorer la démo</div>
                    <div className="mt-1 text-[12.5px] text-muted">Un parcours guidé : création, formulaire avec QR code et exécution en direct. Accessible sans clé.</div>
                  </button>
                </div>
              </Card>
            )}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Kpi testId="kpi-executions" icon={<Activity size={14} />} label="Exécutions · 14 jours" value={String(s.totals.executions)} hint={`${s.totals.success} réussies · ${s.totals.error} échouées`} />
              <Kpi
                testId="kpi-success"
                icon={<CircleCheck size={14} />}
                label="Taux de réussite"
                value={s.successRate === null ? '–' : `${Math.round(s.successRate * 100)}%`}
                hint={s.successRate === null ? 'Aucune exécution terminée' : 'Exécutions terminées sur 14 jours'}
              />
              <Kpi testId="kpi-duration" icon={<Clock size={14} />} label="Durée moyenne" value={s.avgDurationMs === null ? '–' : duration(s.avgDurationMs)} hint="Exécutions terminées" />
              <Kpi testId="kpi-active" icon={<Workflow size={14} />} label="Workflows actifs" value={`${s.workflows.active} / ${s.workflows.total}`} hint="Actifs / total" />
            </div>

            <Section title="Ton activité au fil des jours" action={<Link to="/executions" className={linkCls}>Tout l’historique</Link>}>
              {s.totals.executions === 0 ? (
                <div className="grid h-40 place-items-center text-center text-[13px] text-muted" data-testid="dashboard-empty">
                  <div>
                    Lance ton premier workflow pour voir ton activité ici.
                    <div className="mt-2">
                      <Link to="/workflows" className={linkCls}>Ouvrir mes workflows</Link>
                    </div>
                  </div>
                </div>
              ) : (
                <RunsChart perDay={s.perDay} />
              )}
            </Section>
            <details open className="rounded-xl border border-line bg-panel p-5">
              <summary className="cursor-pointer text-sm font-medium text-muted">État du système et accès réseau</summary>
              <div className="mt-4"><SystemCards /></div>
            </details>

            <div className="grid gap-6 xl:grid-cols-2">
              <Section title="À surveiller" className="min-w-0">
                {s.topFailing.length === 0 ? (
                  <p className="py-6 text-center text-[13px] text-muted">Aucune erreur sur les 14 derniers jours.</p>
                ) : (
                  <ul className="divide-y divide-line" data-testid="top-failing">
                    {s.topFailing.map((f) => (
                      <li key={f.workflowId ?? f.workflowName} className="flex items-start justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          {f.workflowId ? (
                            <Link to={`/workflow/${f.workflowId}`} className="block truncate text-[13px] font-medium hover:text-accent">{f.workflowName}</Link>
                          ) : (
                            <span className="block truncate text-[13px] font-medium">{f.workflowName}</span>
                          )}
                          {f.lastError && <div className="mt-0.5 truncate text-[12px] text-muted" title={f.lastError}>{f.lastError}</div>}
                        </div>
                        <span className="shrink-0 rounded-full bg-danger/15 px-2 py-0.5 text-[12px] font-medium text-[#ffb4b2]">{plural(f.errors, 'error')}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Dernières exécutions" action={<Link to="/executions" className={linkCls}>Tout voir</Link>} className="min-w-0">
                {s.recent.length === 0 ? (
                  <p className="py-6 text-center text-[13px] text-muted">Tes prochaines exécutions apparaîtront ici.</p>
                ) : (
                  <ul className="divide-y divide-line" data-testid="recent-executions">
                    {s.recent.map((e) => (
                      <li key={e.id}>
                        <Link to={`/executions/${e.id}`} className="flex items-center justify-between gap-3 py-2.5 hover:bg-panel-2">
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-medium">{e.workflowName}</div>
                            <div className="text-[12px] text-muted">
                              #{e.id} · {timeAgo(e.startedAt ?? e.createdAt)}
                              {e.durationMs !== null && ` · ${duration(e.durationMs)}`}
                            </div>
                          </div>
                          <StatusBadge status={e.status} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            </div>

            <Section title="Integrations" action={<Link to="/credentials" className={linkCls}>Gérer mes connexions</Link>}>
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" data-testid="integrations">
                {s.integrations.map((i) => {
                  const state = i.count > 0 ? 'configured' : i.fromEnv ? 'from .env' : 'missing';
                  return (
                    <li key={i.type}>
                      <Link to="/credentials" className="flex items-center gap-3 rounded-md border border-line bg-panel-2 px-3 py-2.5 hover:border-line-strong" data-state={state}>
                        <Plug size={15} className="shrink-0 text-subtle" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium">{i.displayName}</div>
                          <div className="text-[12px] text-muted">{i.count > 0 ? plural(i.count, 'credential') : i.fromEnv ? 'Configuré dans .env' : 'À connecter'}</div>
                        </div>
                        <span
                          className={cn(
                            'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                            state === 'configured' && 'bg-success/15 text-[#a6efc6]',
                            state === 'from .env' && 'bg-info/15 text-[#b8d8ff]',
                            state === 'missing' && 'bg-panel-3 text-muted',
                          )}
                        >
                          {state === 'configured' ? 'Connecté' : state === 'from .env' ? 'Via .env' : 'À configurer'}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
