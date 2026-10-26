import { useEffect, useMemo, useState } from 'react';
import { BookOpen, CircleAlert, CircleCheck, Eye, EyeOff, FlaskConical, KeyRound, Lock, Mail, X, type LucideIcon } from 'lucide-react';
import type { CredentialPropertyInfo, CredentialSummary, CredentialTestResult, CredentialTypeInfo, CredentialValue } from '@flowforge/shared';
import { Button } from '../components/ui/Button';
import { cn } from '../components/ui/cn';
import { Spinner } from '../components/ui/Spinner';
import { Toggle } from '../components/ui/Toggle';
import { errorMessage } from '../lib/api';
import { testCredential, useCredentials, useCredentialTypes, useSaveCredential } from '../lib/credentials-api';
import { toast } from '../lib/toast';

const ICONS: Record<string, LucideIcon> = { mail: Mail, lock: Lock, 'key-round': KeyRound };
export const credentialIcon = (type?: CredentialTypeInfo): LucideIcon => ICONS[type?.icon ?? ''] ?? KeyRound;

const inputClass =
  'h-9 w-full rounded-md border border-line-strong bg-panel-2 px-3 text-[13px] text-fg placeholder:text-subtle hover:border-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25';

type Values = Record<string, CredentialValue>;

function PropertyInput({
  property: p,
  value,
  onChange,
  savedSecret,
}: {
  property: CredentialPropertyInfo;
  value: CredentialValue | undefined;
  onChange(v: CredentialValue): void;
  /** Editing: the secret already has a saved value. */
  savedSecret: boolean;
}) {
  const [reveal, setReveal] = useState(false);
  const testId = `credential-field-${p.name}`;
  if (p.type === 'boolean') {
    return (
      <div className="flex items-center gap-2.5">
        <Toggle checked={value === true} onChange={onChange} testId={testId} label={p.displayName} />
        <span className="text-[12.5px] text-muted">{value === true ? 'On' : 'Off'}</span>
      </div>
    );
  }
  if (p.type === 'options') {
    return (
      <select className={inputClass} data-testid={testId} value={String(value ?? '')} onChange={(e) => onChange(p.options?.find((o) => String(o.value) === e.target.value)?.value ?? e.target.value)}>
        {(p.options ?? []).map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  if (p.type === 'number') {
    return <input className={inputClass} data-testid={testId} type="number" value={value === undefined ? '' : String(value)} placeholder={p.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <div className="relative">
      <input
        className={cn(inputClass, p.password && 'pr-10 font-mono')}
        data-testid={testId}
        type={p.password && !reveal ? 'password' : 'text'}
        autoComplete={p.password ? 'new-password' : 'off'}
        spellCheck={false}
        value={value === undefined ? '' : String(value)}
        placeholder={p.password && savedSecret ? '•••••••• saved (leave empty to keep it)' : p.placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {p.password && (
        <button type="button" tabIndex={-1} title={reveal ? 'Hide' : 'Show'} onClick={() => setReveal((r) => !r)} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1.5 text-subtle hover:text-fg">
          {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      )}
    </div>
  );
}

function TypePicker({ types, onPick }: { types: CredentialTypeInfo[]; onPick(type: string): void }) {
  return (
    <div className="grid gap-2 p-5">
      {types.map((t) => {
        const Icon = credentialIcon(t);
        return (
          <button
            key={t.name}
            type="button"
            data-testid={`credential-type-${t.name}`}
            onClick={() => onPick(t.name)}
            className="flex items-center gap-3 rounded-lg border border-line bg-panel-2/60 px-4 py-3 text-left hover:border-accent hover:bg-panel-2"
          >
            <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-line bg-panel text-accent-hover">
              <Icon size={19} />
            </div>
            <div className="min-w-0">
              <div className="text-[14px] font-medium">{t.displayName}</div>
              <div className="text-[12.5px] text-muted">{t.description}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export interface CredentialDialogProps {
  /** Type to create (skips the type picker). */
  type?: string;
  /** Credential to edit. */
  credential?: CredentialSummary;
  onClose(): void;
  onSaved?(credential: CredentialSummary): void;
}

/** Create or edit a credential: fields come from the credential type schema; secrets are write-only. */
export function CredentialDialog({ type: initialType, credential, onClose, onSaved }: CredentialDialogProps) {
  const types = useCredentialTypes();
  const all = useCredentials();
  const save = useSaveCredential();
  const [typeName, setTypeName] = useState(credential?.type ?? initialType);
  const type = types.data?.find((t) => t.name === typeName);
  const [name, setName] = useState(credential?.name ?? '');
  const [values, setValues] = useState<Values>(credential?.data ?? {});
  const [makeDefault, setMakeDefault] = useState(credential?.isDefault ?? false);
  const [preset, setPreset] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<CredentialTestResult>();
  const [error, setError] = useState<string>();
  const sameType = useMemo(() => (all.data ?? []).filter((c) => c.type === typeName && c.id !== credential?.id), [all.data, typeName, credential?.id]);

  // New credential: start from the schema defaults.
  useEffect(() => {
    if (!type || credential) return;
    setValues(Object.fromEntries(type.properties.filter((p) => p.default !== undefined).map((p) => [p.name, p.default!])));
    setName((n) => n || `${type.displayName} account`);
  }, [type, credential]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const set = (key: string, v: CredentialValue) => {
    setValues((current) => ({ ...current, [key]: v }));
    setResult(undefined);
    setError(undefined);
  };
  const applyPreset = (id: string) => {
    const p = type?.presets?.find((x) => x.id === id);
    if (!p) return;
    setPreset(id);
    setValues((current) => ({ ...current, ...p.values }));
    setName((n) => (!n || n === `${type!.displayName} account` || type!.presets!.some((x) => n === `${x.name} account`) ? `${p.name} account` : n));
    setResult(undefined);
  };
  const runTest = async () => {
    if (!type) return;
    setTesting(true);
    setResult(undefined);
    setError(undefined);
    try {
      setResult(await testCredential({ type: type.name, data: values, id: credential?.id }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setTesting(false);
    }
  };
  const submit = () => {
    if (!type) return;
    setError(undefined);
    save.mutate(
      { id: credential?.id, name, type: type.name, data: values, ...(makeDefault !== (credential?.isDefault ?? false) || !credential ? { isDefault: makeDefault } : {}) },
      {
        onSuccess: (saved) => {
          toast.success(credential ? 'Credential saved' : 'Credential created', `${saved.name} is stored encrypted.`);
          onSaved?.(saved);
          onClose();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  const Icon = credentialIcon(type);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[92vh] w-[560px] max-w-[94vw] animate-fade-in flex-col overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl" role="dialog" aria-label="Credential" data-testid="credential-dialog">
        <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-panel-2 text-accent-hover">
            <Icon size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold">{!type ? 'New credential' : credential ? `Edit ${type.displayName} credential` : `New ${type.displayName} credential`}</h2>
            <p className="truncate text-[12px] text-subtle">{type ? type.description : 'Choose what you want to connect.'}</p>
          </div>
          <button type="button" onClick={onClose} title="Close (Esc)" className="rounded p-1.5 text-subtle hover:bg-panel-3 hover:text-fg" data-testid="credential-close">
            <X size={16} />
          </button>
        </header>

        {types.isPending ? (
          <div className="grid place-items-center p-10">
            <Spinner />
          </div>
        ) : !type ? (
          <TypePicker types={types.data ?? []} onPick={setTypeName} />
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
              {credential?.error && (
                <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] text-[#ffd99b]">
                  <CircleAlert size={15} className="mt-0.5 shrink-0" /> {credential.error}
                </div>
              )}
              {type.presets && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] font-medium text-muted">Quick setup</span>
                  <div className="flex flex-wrap gap-2">
                    {type.presets.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        data-testid={`credential-preset-${p.id}`}
                        onClick={() => applyPreset(p.id)}
                        className={cn('rounded-md border px-3 py-1.5 text-[12.5px] font-medium', preset === p.id ? 'border-accent bg-accent-soft text-fg' : 'border-line-strong bg-panel-2 text-muted hover:border-accent hover:text-fg')}
                      >
                        {p.name}
                      </button>
                    ))}
                  </div>
                  {preset && <p className="text-[12px] text-subtle">{type.presets.find((p) => p.id === preset)?.description}</p>}
                </div>
              )}

              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-medium text-muted">Credential name</span>
                <input className={inputClass} data-testid="credential-name" value={name} maxLength={128} onChange={(e) => setName(e.target.value)} placeholder={`${type.displayName} account`} />
              </label>

              {type.properties.map((p) => (
                <div key={p.name} className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] font-medium text-muted">
                    {p.displayName}
                    {p.required && <span className="ml-0.5 text-accent">*</span>}
                  </span>
                  <PropertyInput property={p} value={values[p.name]} onChange={(v) => set(p.name, v)} savedSecret={Boolean(credential?.secrets.includes(p.name))} />
                  {p.description && <p className="text-[12px] leading-snug text-subtle">{p.description}</p>}
                </div>
              ))}

              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line bg-panel-2/50 px-3 py-2.5">
                <input type="checkbox" className="mt-0.5 accent-[#f0592a]" data-testid="credential-default" checked={makeDefault || (!credential && sameType.length === 0)} disabled={!credential && sameType.length === 0} onChange={(e) => setMakeDefault(e.target.checked)} />
                <span className="text-[12.5px]">
                  <span className="font-medium">Default for {type.displayName}</span>
                  <span className="block text-subtle">Used by every node that has no credential selected.</span>
                </span>
              </label>

              {type.envConfigured && (
                <p className="text-[12px] text-subtle">
                  <code className="rounded bg-panel-2 px-1">.env</code> also provides {type.displayName} settings. A saved credential always wins over <code className="rounded bg-panel-2 px-1">.env</code>.
                </p>
              )}
              {type.docsAnchor && (
                <p className="flex items-center gap-1.5 text-[12px] text-subtle">
                  <BookOpen size={13} /> Step-by-step guide: <code className="rounded bg-panel-2 px-1">API_SETUP.md{type.docsAnchor}</code>
                </p>
              )}

            </div>

            {/* Outside the scrolling area: the answer of Test / Save is always in view. */}
            <div className="flex flex-col gap-2 px-5 empty:hidden [&:not(:empty)]:pb-3">
              {result && (
                <div
                  data-testid="credential-test-result"
                  data-ok={result.ok}
                  className={cn('flex gap-2 rounded-md border px-3 py-2.5 text-[12.5px]', result.ok ? 'border-success/40 bg-success/10 text-[#a6efc6]' : 'border-danger/40 bg-danger/10 text-[#ffb4b2]')}
                >
                  {result.ok ? <CircleCheck size={15} className="mt-0.5 shrink-0" /> : <CircleAlert size={15} className="mt-0.5 shrink-0" />}
                  <div>
                    <div className="font-medium">{result.message}</div>
                    {result.hint && <div className="mt-1 text-fg/90">💡 {result.hint}</div>}
                  </div>
                </div>
              )}
              {error && (
                <div className="flex gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2.5 text-[12.5px] text-[#ffb4b2]" role="alert" data-testid="credential-error">
                  <CircleAlert size={15} className="mt-0.5 shrink-0" /> {error}
                </div>
              )}
            </div>

            <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
              {type.testable && (
                <Button variant="secondary" icon={<FlaskConical size={15} />} loading={testing} onClick={() => void runTest()} data-testid="credential-test">
                  Test
                </Button>
              )}
              <span className="flex items-center gap-1.5 text-[11.5px] text-subtle">
                <Lock size={12} /> Encrypted with AES-256-GCM
              </span>
              <div className="ml-auto flex gap-2">
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button loading={save.isPending} onClick={submit} data-testid="credential-save">
                  Save
                </Button>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
