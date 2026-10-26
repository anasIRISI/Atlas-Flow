import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Database, Gauge, ShieldAlert, Terminal, Trash2 } from 'lucide-react';
import type { InstanceSettings, PruneResult, SaveDataPolicy, SettingsResponse } from '@flowforge/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { Toggle } from '../components/ui/Toggle';
import { api, errorMessage } from '../lib/api';
import { toast } from '../lib/toast';
import { useTitle } from '../lib/useTitle';
import { PageHeader } from './PageHeader';

const settingsKey = ['settings'] as const;
const selectClass = 'h-9 rounded-md border border-line-strong bg-panel-2 px-3 text-[13px] text-fg focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25';
const inputClass = `${selectClass} w-full`;

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-[13px] font-semibold">
        <span className="text-accent-hover">{icon}</span> {title}
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">{children}</div>
    </Card>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_260px] md:items-start md:gap-6">
      <div>
        <div className="text-[14px] font-medium">{label}</div>
        {hint && <p className="mt-0.5 text-[12.5px] text-muted">{hint}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}

const POLICIES: Array<{ value: SaveDataPolicy; label: string }> = [
  { value: 'all', label: 'Save' },
  { value: 'none', label: 'Do not save' },
];

type Draft = Pick<
  InstanceSettings,
  'timezone' | 'executionTimeoutSeconds' | 'maxConcurrentExecutions' | 'saveDataSuccess' | 'saveDataError' | 'saveDataManual' | 'pruneMaxAgeDays' | 'pruneMaxCount'
>;
const draftOf = (s: InstanceSettings): Draft => ({
  timezone: s.timezone,
  executionTimeoutSeconds: s.executionTimeoutSeconds,
  maxConcurrentExecutions: s.maxConcurrentExecutions,
  saveDataSuccess: s.saveDataSuccess,
  saveDataError: s.saveDataError,
  saveDataManual: s.saveDataManual,
  pruneMaxAgeDays: s.pruneMaxAgeDays,
  pruneMaxCount: s.pruneMaxCount,
});

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Europe/Paris', 'Europe/London', 'America/New_York', 'Asia/Tokyo'];
  }
}
const validZone = (tz: string) => {
  if (!tz) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Defaults the user edits and saves together (General, Executions, Data retention). */
function DefaultsForm({ settings }: { settings: SettingsResponse }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(settings));
  useEffect(() => setDraft(draftOf(settings)), [settings]);
  const list = useMemo(zones, []);
  const set = <K extends keyof Draft>(name: K, value: Draft[K]) => setDraft((d) => ({ ...d, [name]: value }));
  const num = (name: keyof Draft, max: number) => (
    <input
      type="number"
      min={0}
      max={max}
      step={1}
      className={inputClass}
      value={draft[name] as number}
      data-testid={`setting-${name}`}
      onChange={(e) => set(name as 'pruneMaxCount', e.target.value === '' ? 0 : Math.trunc(Number(e.target.value)))}
    />
  );
  const eff = settings.effective;
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(settings));
  const bad =
    !validZone(draft.timezone) ||
    draft.executionTimeoutSeconds < 0 || draft.executionTimeoutSeconds > 86_400 ||
    draft.maxConcurrentExecutions < 0 || draft.maxConcurrentExecutions > 50 ||
    draft.pruneMaxAgeDays < 0 || draft.pruneMaxAgeDays > 3650 ||
    draft.pruneMaxCount < 0 || draft.pruneMaxCount > 1_000_000 ||
    Object.values(draft).some((v) => typeof v === 'number' && !Number.isFinite(v));
  const save = useMutation({
    mutationFn: () => api<SettingsResponse>('/settings', { method: 'PATCH', body: draft }),
    onSuccess: (data) => {
      client.setQueryData(settingsKey, data);
      toast.success('Settings saved');
    },
    onError: (err) => toast.error('Could not save the settings', errorMessage(err)),
  });
  const prune = useMutation({
    mutationFn: () => api<PruneResult>('/executions/prune', { method: 'POST', body: {} }),
    onSuccess: (r) => toast.success('Pruning done', `${r.deleted} execution${r.deleted === 1 ? '' : 's'} deleted`),
    onError: (err) => toast.error('Could not prune', errorMessage(err)),
  });
  const policy = (name: 'saveDataSuccess' | 'saveDataError' | 'saveDataManual') => (
    <select className={`${selectClass} w-full`} value={draft[name]} onChange={(e) => set(name, e.target.value as SaveDataPolicy)} data-testid={`setting-${name}`}>
      {POLICIES.map((p) => (
        <option key={p.value} value={p.value}>
          {p.label}
        </option>
      ))}
    </select>
  );

  return (
    <>
      <Section icon={<Clock size={16} />} title="General">
        <Row label="Default time zone" hint={<>Used by <code>$now</code>, schedules and date nodes. A workflow's own time zone wins. In effect: <b className="text-fg" data-testid="effective-timezone">{eff.timezone}</b>. Changing it restarts active workflows.</>}>
          <div className="flex gap-2">
            <input
              className={inputClass}
              list="ff-zones"
              placeholder={`.env value (${eff.timezone})`}
              value={draft.timezone}
              onChange={(e) => set('timezone', e.target.value)}
              aria-invalid={!validZone(draft.timezone)}
              data-testid="setting-timezone"
            />
            <datalist id="ff-zones">
              {list.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            <Button type="button" size="sm" variant="secondary" className="shrink-0 whitespace-nowrap" onClick={() => set('timezone', '')} disabled={!draft.timezone}>
              Use .env
            </Button>
          </div>
          {!validZone(draft.timezone) && <p className="mt-1 text-[12px] text-danger">Not a valid time zone. Pick one from the list, e.g. Europe/Paris.</p>}
        </Row>
      </Section>

      <Section icon={<Gauge size={16} />} title="Executions">
        <Row label="Execution timeout (seconds)" hint={<>0 = use the .env value. In effect: <b className="text-fg">{eff.executionTimeoutSeconds} s</b>. A workflow's own timeout wins.</>}>
          {num('executionTimeoutSeconds', 86_400)}
        </Row>
        <Row label="Concurrent executions" hint={<>0 = use the .env value. In effect: <b className="text-fg">{eff.maxConcurrentExecutions}</b>. Applies immediately.</>}>
          {num('maxConcurrentExecutions', 50)}
        </Row>
        <Row label="Save successful runs" hint="Production runs. A workflow's own setting wins.">
          {policy('saveDataSuccess')}
        </Row>
        <Row label="Save failed runs" hint="Production runs. A workflow's own setting wins.">
          {policy('saveDataError')}
        </Row>
        <Row label="Save manual runs" hint="Runs started from the editor. When off, they are removed a few minutes after they finish.">
          {policy('saveDataManual')}
        </Row>
      </Section>

      <Section icon={<Database size={16} />} title="Data retention">
        <Row label="Delete executions older than (days)" hint="0 = never. Running and waiting executions are never deleted.">
          {num('pruneMaxAgeDays', 3650)}
        </Row>
        <Row label="Keep at most (executions)" hint="0 = no limit. The newest ones are kept.">
          {num('pruneMaxCount', 1_000_000)}
        </Row>
        <div>
          <Button type="button" size="sm" variant="secondary" icon={<Trash2 size={14} />} loading={prune.isPending} onClick={() => prune.mutate()} disabled={dirty} data-testid="prune-now" title={dirty ? 'Save first: pruning uses the saved values' : undefined}>
            Prune now
          </Button>
        </div>
      </Section>

      <div className="flex items-center gap-3">
        <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || bad} data-testid="settings-save">
          Save changes
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => setDraft(draftOf(settings))}>
            Discard
          </Button>
        )}
      </div>
    </>
  );
}

export function SettingsPage() {
  useTitle('Paramètres');
  const client = useQueryClient();
  const settings = useQuery({ queryKey: settingsKey, queryFn: () => api<SettingsResponse>('/settings') });
  const update = useMutation({
    mutationFn: (patch: Partial<InstanceSettings>) => api<SettingsResponse>('/settings', { method: 'PATCH', body: patch }),
    onSuccess: (data) => client.setQueryData(settingsKey, data),
    onError: (err) => toast.error('Could not save the setting', errorMessage(err)),
  });
  const [confirm, setConfirm] = useState(false);
  const enabled = settings.data?.executeCommandEnabled === true;

  return (
    <div className="animate-fade-in">
      <PageHeader title="Paramètres" subtitle="Personnalise le fonctionnement de ton espace Atlas Flow." />
      <div className="flex max-w-3xl flex-col gap-5 px-8 py-6">
        {settings.isPending ? (
          <Spinner />
        ) : settings.isError ? (
          <Alert>{errorMessage(settings.error)}</Alert>
        ) : (
          <>
          <DefaultsForm settings={settings.data} />
          <Card>
            <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-[13px] font-semibold">
              <ShieldAlert size={16} className="text-accent-hover" /> Security
            </div>
            <div className="flex flex-wrap items-start gap-4 border-b border-line px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium">Environment variables in expressions (<code>$env</code>)</div>
                <p className="mt-0.5 text-[12.5px] text-muted">
                  Lets expressions and the Code node read <code>$env</code>. Names that look like secrets (KEY, TOKEN, PASSWORD…) are always hidden. In effect:{' '}
                  <b className="text-fg" data-testid="effective-allowEnvAccess">{settings.data.effective.allowEnvAccess ? 'allowed' : 'blocked'}</b>.
                </p>
              </div>
              <select
                className={selectClass}
                value={settings.data.allowEnvAccess === null ? 'default' : settings.data.allowEnvAccess ? 'on' : 'off'}
                data-testid="setting-allowEnvAccess"
                onChange={(e) => update.mutate({ allowEnvAccess: e.target.value === 'default' ? null : e.target.value === 'on' })}
              >
                <option value="default">Use .env value</option>
                <option value="on">Allowed</option>
                <option value="off">Blocked</option>
              </select>
            </div>
            <div className="flex items-start gap-4 px-5 py-4">
              <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-line bg-panel-2 text-accent-hover">
                <Terminal size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium">Allow the Execute Command node</div>
                <p className="mt-0.5 text-[12.5px] text-muted">
                  The Execute Command node runs shell commands on the computer where FlowForge is installed, with the same rights as FlowForge. It is{' '}
                  <b className="text-fg">off by default</b>. While it is off, the node fails with a clear message and nothing is run.
                </p>
                <p className="mt-1.5 text-[12px]" data-testid="setting-executeCommand-state">
                  {enabled ? <span className="text-warning">Enabled: workflows can run commands on this computer.</span> : <span className="text-success">Disabled (safe).</span>}
                </p>
              </div>
              <Toggle
                checked={enabled}
                label="Allow the Execute Command node"
                testId="setting-executeCommandEnabled"
                onChange={(next) => (next ? setConfirm(true) : update.mutate({ executeCommandEnabled: false }, { onSuccess: () => toast.info('Execute Command disabled') }))}
              />
            </div>
          </Card>
          </>
        )}
      </div>
      {confirm && (
        <ConfirmDialog
          title="Allow shell commands?"
          message="Any workflow will be able to run commands on this computer with the rights of FlowForge: read and delete files, install programs… Enable it only if you trust everyone who can edit workflows here."
          confirmLabel="Enable Execute Command"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            update.mutate({ executeCommandEnabled: true }, { onSuccess: () => toast.success('Execute Command enabled', 'You can turn it off again here at any time.') });
          }}
        />
      )}
    </div>
  );
}
