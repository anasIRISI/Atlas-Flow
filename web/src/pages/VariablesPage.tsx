import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Braces, Check, Copy, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { Variable } from '@flowforge/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { copyText } from '../components/CopyButton';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { setKnownVariableKeys } from '../editor/params/cm';
import { api, errorMessage } from '../lib/api';
import { timeAgo } from '../lib/format';
import { toast } from '../lib/toast';
import { useTitle } from '../lib/useTitle';
import { PageHeader } from './PageHeader';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const key = ['variables'] as const;
const inputClass = 'h-9 w-full rounded-md border border-line-strong bg-panel-2 px-3 text-[13px] text-fg focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25';

async function copy(text: string) {
  if (await copyText(text)) toast.success('Copied', text);
  else toast.error('Could not copy', 'Select the text and copy it by hand.');
}

/** Add / edit form row (same markup for both). */
function EditRow({ initial, onCancel, onDone }: { initial?: Variable; onCancel(): void; onDone(): void }) {
  const client = useQueryClient();
  const [k, setK] = useState(initial?.key ?? '');
  const [v, setV] = useState(initial?.value ?? '');
  const keyError = k && !KEY_RE.test(k) ? 'Letters, digits and _ only (max 64), not starting with a digit.' : '';
  const save = useMutation({
    mutationFn: () =>
      initial
        ? api<Variable>(`/variables/${initial.id}`, { method: 'PATCH', body: { key: k, value: v } })
        : api<Variable>('/variables', { method: 'POST', body: { key: k, value: v } }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key });
      toast.success(initial ? 'Variable updated' : 'Variable created');
      onDone();
    },
    onError: (err) => toast.error('Could not save the variable', errorMessage(err)),
  });
  const valid = KEY_RE.test(k) && v.length <= 10_000;
  return (
    <form
      className="flex flex-wrap items-start gap-3 border-b border-line bg-panel-2/50 px-5 py-3"
      data-testid="variable-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <div className="w-56">
        <input className={inputClass} placeholder="KEY" value={k} onChange={(e) => setK(e.target.value)} autoFocus aria-label="Variable key" data-testid="variable-key" />
        {keyError && <p className="mt-1 text-[12px] text-danger">{keyError}</p>}
      </div>
      <div className="min-w-[220px] flex-1">
        <input className={inputClass} placeholder="value" value={v} onChange={(e) => setV(e.target.value)} aria-label="Variable value" data-testid="variable-value" />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" icon={<Check size={14} />} loading={save.isPending} disabled={!valid} data-testid="variable-save">
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" icon={<X size={14} />} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Row({ variable, onEdit }: { variable: Variable; onEdit(): void }) {
  const client = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => api<void>(`/variables/${variable.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: key });
      toast.success('Variable deleted');
    },
    onError: (err) => toast.error('Could not delete', errorMessage(err)),
  });
  const expr = `{{ $vars.${variable.key} }}`;
  return (
    <div className="group flex items-center gap-4 border-b border-line px-5 py-3 last:border-b-0 hover:bg-panel-2/60" data-testid="variable-row" data-key={variable.key}>
      <code className="w-56 shrink-0 truncate text-[13px] font-medium text-accent-hover">{variable.key}</code>
      <div className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-muted" title={variable.value}>
        {variable.value || <span className="text-subtle">(empty)</span>}
      </div>
      <span className="hidden text-[12px] text-subtle md:block">{timeAgo(variable.updatedAt)}</span>
      <div className="flex items-center gap-1">
        <button type="button" title={`Copy ${expr}`} onClick={() => void copy(expr)} className="flex items-center gap-1 rounded p-2 text-subtle hover:bg-panel-3 hover:text-fg" data-testid="variable-copy">
          <Copy size={14} />
        </button>
        <button type="button" title="Edit" onClick={onEdit} className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-fg" data-testid="variable-edit">
          <Pencil size={15} />
        </button>
        <button type="button" title="Delete" onClick={() => setConfirm(true)} className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-danger" data-testid="variable-delete">
          <Trash2 size={15} />
        </button>
      </div>
      {confirm && (
        <ConfirmDialog
          title={`Delete "${variable.key}"?`}
          message="Expressions and Code nodes that use it will get undefined."
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            remove.mutate();
          }}
        />
      )}
    </div>
  );
}

export function VariablesPage() {
  useTitle('Variables');
  const list = useQuery({
    queryKey: key,
    queryFn: async () => {
      const data = await api<Variable[]>('/variables');
      setKnownVariableKeys(data.map((x) => x.key));
      return data;
    },
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Variables"
        subtitle={
          <>
            Values shared by all workflows. Read them with <code className="rounded bg-panel-2 px-1">{'{{ $vars.name }}'}</code> in expressions or <code className="rounded bg-panel-2 px-1">$vars.name</code> in the Code node.
          </>
        }
        actions={
          <Button icon={<Plus size={15} />} onClick={() => { setAdding(true); setEditing(null); }} data-testid="variable-add">
            Add variable
          </Button>
        }
      />
      <div className="flex max-w-4xl flex-col gap-4 px-8 py-6">
        <Alert kind="info">Variables are not secret: anyone who can edit workflows can read them. Put passwords and API keys in Credentials.</Alert>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <Alert>{errorMessage(list.error)}</Alert>
        ) : (
          <Card className="overflow-hidden">
            {adding && <EditRow onCancel={() => setAdding(false)} onDone={() => setAdding(false)} />}
            {list.data.length === 0 && !adding ? (
              <div className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid="variables-empty">
                <div className="grid size-12 place-items-center rounded-xl border border-line bg-panel-2 text-accent-hover">
                  <Braces size={22} />
                </div>
                <div className="text-[15px] font-medium">No variables yet</div>
                <p className="max-w-md text-[13px] text-muted">
                  A variable is a named value, for example <code className="rounded bg-panel-2 px-1">city = Paris</code>. Use it in any workflow with{' '}
                  <code className="rounded bg-panel-2 px-1">{'{{ $vars.city }}'}</code>, and change it once for all workflows.
                </p>
                <Button icon={<Plus size={15} />} onClick={() => setAdding(true)}>
                  Add your first variable
                </Button>
              </div>
            ) : (
              list.data.map((v) =>
                editing === v.id ? <EditRow key={v.id} initial={v} onCancel={() => setEditing(null)} onDone={() => setEditing(null)} /> : <Row key={v.id} variable={v} onEdit={() => { setEditing(v.id); setAdding(false); }} />,
              )
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
