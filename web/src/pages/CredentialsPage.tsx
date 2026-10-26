import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { CircleAlert, CircleCheck, FlaskConical, KeyRound, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import type { CredentialSummary, CredentialTestResult, CredentialTypeInfo } from '@flowforge/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { cn } from '../components/ui/cn';
import { Spinner } from '../components/ui/Spinner';
import { CredentialDialog, credentialIcon } from '../credentials/CredentialDialog';
import { errorMessage } from '../lib/api';
import { testCredential, testEnvCredential, useCredentials, useCredentialTypes, useDeleteCredential, useSaveCredential } from '../lib/credentials-api';
import { timeAgo } from '../lib/format';
import { toast } from '../lib/toast';
import { useTitle } from '../lib/useTitle';
import { PageHeader } from './PageHeader';

function TestBadge({ result }: { result: CredentialTestResult }) {
  return (
    <div className={cn('mt-1 flex items-start gap-1.5 text-[12px]', result.ok ? 'text-success' : 'text-danger')} data-testid="credential-row-test" data-ok={result.ok}>
      {result.ok ? <CircleCheck size={13} className="mt-0.5 shrink-0" /> : <CircleAlert size={13} className="mt-0.5 shrink-0" />}
      <span>
        {result.message}
        {result.hint && <span className="text-muted"> {result.hint}</span>}
      </span>
    </div>
  );
}

function Row({ credential, type, onEdit }: { credential: CredentialSummary; type?: CredentialTypeInfo; onEdit(): void }) {
  const [confirm, setConfirm] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<CredentialTestResult>();
  const remove = useDeleteCredential();
  const save = useSaveCredential();
  const Icon = credentialIcon(type);
  const summary = type?.properties
    .filter((p) => !p.password && credential.data[p.name] !== undefined && typeof credential.data[p.name] !== 'boolean')
    .slice(0, 3)
    .map((p) => String(credential.data[p.name]))
    .join(' · ');
  const test = async () => {
    setTesting(true);
    try {
      setResult(await testCredential({ type: credential.type, data: {}, id: credential.id }));
    } catch (err) {
      toast.error('Could not test', errorMessage(err));
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="group flex items-center gap-4 border-b border-line px-5 py-3.5 last:border-b-0 hover:bg-panel-2/60" data-testid="credential-row" data-name={credential.name}>
      <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-line bg-panel-2 text-accent-hover">
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onEdit} className="truncate text-[14px] font-medium hover:text-accent-hover" data-testid="credential-open">
            {credential.name}
          </button>
          {credential.isDefault && (
            <span className="flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-hover" data-testid="credential-default-badge" title="Used by nodes without a selected credential">
              <Star size={10} fill="currentColor" /> Default
            </span>
          )}
        </div>
        <div className="truncate text-[12px] text-subtle">
          {type?.displayName ?? credential.type}
          {summary ? ` · ${summary}` : ''} · updated {timeAgo(credential.updatedAt)}
        </div>
        {credential.error && <div className="text-[12px] text-warning">{credential.error}</div>}
        {result && <TestBadge result={result} />}
      </div>
      <div className="flex items-center gap-1">
        {type?.testable && (
          <Button size="sm" variant="secondary" icon={<FlaskConical size={14} />} loading={testing} onClick={() => void test()} data-testid="credential-row-test-button">
            Test
          </Button>
        )}
        {!credential.isDefault && (
          <button
            type="button"
            title="Make default"
            data-testid="credential-make-default"
            onClick={() => save.mutate({ id: credential.id, isDefault: true }, { onSuccess: () => toast.success(`${credential.name} is now the default`), onError: (err) => toast.error('Could not update', errorMessage(err)) })}
            className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-fg"
          >
            <Star size={15} />
          </button>
        )}
        <button type="button" title="Edit" data-testid="credential-edit" onClick={onEdit} className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-fg">
          <Pencil size={15} />
        </button>
        <button type="button" title="Delete" data-testid="credential-delete" onClick={() => setConfirm(true)} className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-danger">
          <Trash2 size={15} />
        </button>
      </div>
      {confirm && (
        <ConfirmDialog
          title={`Delete "${credential.name}"?`}
          message="Nodes that use this credential fall back to the default credential of its type, then to .env."
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            remove.mutate(credential.id, { onSuccess: () => toast.success('Credential deleted'), onError: (err) => toast.error('Could not delete', errorMessage(err)) });
          }}
        />
      )}
    </div>
  );
}

/** `.env` fallbacks that are configured, each with its own Test button. */
function EnvFallback({ type }: { type: CredentialTypeInfo }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<CredentialTestResult>();
  const variables = type.properties.flatMap((p) => (p.env ? [p.env] : []));
  return (
    <div className="flex items-center gap-4 px-5 py-3.5" data-testid={`env-fallback-${type.name}`}>
      <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-dashed border-line-strong text-subtle">
        <KeyRound size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium">
          {type.displayName} from <code className="rounded bg-panel-2 px-1 text-[13px]">.env</code>
        </div>
        <div className="truncate text-[12px] text-subtle">Fallback when no credential is saved · {variables.join(', ')}</div>
        {result && <TestBadge result={result} />}
      </div>
      {type.testable && (
        <Button
          size="sm"
          variant="secondary"
          icon={<FlaskConical size={14} />}
          loading={testing}
          onClick={() => {
            setTesting(true);
            testEnvCredential(type.name)
              .then(setResult, (err) => toast.error('Could not test', errorMessage(err)))
              .finally(() => setTesting(false));
          }}
        >
          Test
        </Button>
      )}
    </div>
  );
}

export function CredentialsPage() {
  useTitle('Connexions');
  const [params, setParams] = useSearchParams();
  const credentials = useCredentials();
  const types = useCredentialTypes();
  // /credentials?new=smtp opens the dialog directly (used by "Open Credentials" links).
  const [dialog, setDialog] = useState<{ type?: string; credential?: CredentialSummary } | null>(params.has('new') ? { type: params.get('new') || undefined } : null);
  const byName = new Map((types.data ?? []).map((t) => [t.name, t]));
  const env = (types.data ?? []).filter((t) => t.envConfigured);
  const close = () => {
    setDialog(null);
    if (params.has('new')) setParams({}, { replace: true });
  };

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Mes connexions"
        subtitle="Connecte tes services. Tes identifiants et clés API sont chiffrés après enregistrement."
        actions={
          <Button icon={<Plus size={16} />} onClick={() => setDialog({})} data-testid="create-credential">
            Add credential
          </Button>
        }
      />
      <div className="flex flex-col gap-5 px-8 py-6">
        {credentials.isPending || types.isPending ? (
          <Spinner />
        ) : credentials.isError ? (
          <Alert>{errorMessage(credentials.error)}</Alert>
        ) : credentials.data.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid="credentials-empty">
            <div className="grid size-14 place-items-center rounded-2xl border border-line bg-panel-2 text-accent-hover">
              <KeyRound size={26} />
            </div>
            <h2 className="text-base font-semibold">No credentials yet</h2>
            <p className="max-w-md text-muted">Add your SMTP login (Gmail App Password or Brevo) to send emails. It is tested and encrypted before any workflow uses it.</p>
            <Button icon={<Plus size={16} />} onClick={() => setDialog({})}>
              Add your first credential
            </Button>
          </Card>
        ) : (
          <Card data-testid="credential-list">
            {credentials.data.map((c) => (
              <Row key={c.id} credential={c} type={byName.get(c.type)} onEdit={() => setDialog({ credential: c })} />
            ))}
          </Card>
        )}
        {env.length > 0 && (
          <Card>
            {env.map((t) => (
              <EnvFallback key={t.name} type={t} />
            ))}
          </Card>
        )}
      </div>
      {dialog && <CredentialDialog type={dialog.type} credential={dialog.credential} onClose={close} />}
    </div>
  );
}
