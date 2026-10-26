import { useState } from 'react';
import { CircleCheck, KeyRound, Pencil, Plus, TriangleAlert } from 'lucide-react';
import type { CredentialSummary, CredentialTypeInfo, NodeProperty, NodeTypeInfo, WorkflowNode } from '@flowforge/shared';
import { Button } from '../../components/ui/Button';
import { CredentialDialog } from '../../credentials/CredentialDialog';
import { useCredentials, useCredentialTypes } from '../../lib/credentials-api';
import { isVisible, withDefaults } from '../params/display';
import { inputClass } from '../params/Field';
import { editor } from '../store';

const NEW = '__new__';

/** Selects (or creates) the credential a node uses for one credential type. */
function CredentialSelect({ node, type, all }: { node: WorkflowNode; type: CredentialTypeInfo; all: CredentialSummary[] }) {
  const [dialog, setDialog] = useState<{ credential?: CredentialSummary } | null>(null);
  const list = all.filter((c) => c.type === type.name);
  const selected = node.credentials?.[type.name];
  const current = selected ? (list.find((c) => c.id === selected.id) ?? list.find((c) => c.name === selected.name)) : undefined;
  const fallback = list.find((c) => c.isDefault);
  const effective = current ?? fallback;
  const select = (credential: CredentialSummary | undefined) => {
    const next = { ...(node.credentials ?? {}) };
    if (credential) next[type.name] = { id: credential.id, name: credential.name };
    else delete next[type.name];
    editor.updateNode(node.name, { credentials: Object.keys(next).length ? next : undefined });
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-panel-2/50 p-2.5" data-testid={`node-credential-${type.name}`}>
      <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-muted">
        <KeyRound size={13} className="text-accent-hover" /> Credential to connect with
        <span className="font-normal text-subtle">· {type.displayName}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <select
          className={inputClass}
          data-testid={`credential-select-${type.name}`}
          value={current?.id ?? ''}
          onChange={(e) => {
            if (e.target.value === NEW) return setDialog({});
            select(list.find((c) => c.id === e.target.value));
          }}
        >
          <option value="">{fallback ? `Default (${fallback.name})` : type.envConfigured ? 'Settings from .env' : list.length ? 'No default credential' : 'No credential yet'}</option>
          {list.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.isDefault ? ' · default' : ''}
            </option>
          ))}
          <option value={NEW}>+ Create new credential…</option>
        </select>
        {effective && (
          <button type="button" title={`Edit "${effective.name}"`} data-testid={`credential-edit-${type.name}`} onClick={() => setDialog({ credential: effective })} className="rounded-md border border-line bg-panel-2 p-1.5 text-muted hover:border-accent hover:text-fg">
            <Pencil size={14} />
          </button>
        )}
      </div>
      {selected && !current ? (
        <p className="flex items-start gap-1.5 text-[11.5px] text-warning" data-testid={`credential-status-${type.name}`} data-status="missing">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          <span>
            "{selected.name}" does not exist here. {fallback ? `The default (${fallback.name}) is used instead.` : type.envConfigured ? '.env is used instead.' : 'Choose or create a credential.'}
          </span>
        </p>
      ) : effective ? (
        <p className="flex items-center gap-1.5 text-[11.5px] text-subtle" data-testid={`credential-status-${type.name}`} data-status="ok">
          <CircleCheck size={12} className="text-success" /> Using "{effective.name}"{current ? '' : ' (default)'}.
        </p>
      ) : type.envConfigured ? (
        <p className="flex items-center gap-1.5 text-[11.5px] text-subtle" data-testid={`credential-status-${type.name}`} data-status="env">
          <CircleCheck size={12} className="text-success" /> Using the {type.displayName} settings from .env.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2" data-testid={`credential-status-${type.name}`} data-status="none">
          <span className="flex items-center gap-1.5 text-[11.5px] text-warning">
            <TriangleAlert size={12} /> This node needs a {type.displayName} credential.
          </span>
          <Button size="sm" icon={<Plus size={13} />} onClick={() => setDialog({})} data-testid={`credential-create-${type.name}`}>
            Create credential
          </Button>
        </div>
      )}
      {dialog && (
        <CredentialDialog
          type={type.name}
          credential={dialog.credential}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            // A credential created from the node is selected on it; a renamed one keeps its reference in sync.
            if (!dialog.credential || current?.id === saved.id) select(saved);
          }}
        />
      )}
    </div>
  );
}

/** Credential selectors of the node being edited (only the types its current parameters need). */
export function NodeCredentials({ node, type }: { node: WorkflowNode; type: NodeTypeInfo }) {
  const types = useCredentialTypes();
  const credentials = useCredentials();
  if (!type.credentials?.length) return null;
  const level = withDefaults(type.properties, node.parameters);
  const needed = type.credentials.filter((c) => isVisible({ displayOptions: c.displayOptions } as NodeProperty, level, node.parameters));
  if (!needed.length || !types.data) return null;
  return (
    <div className="mb-4 flex flex-col gap-2">
      {needed.map((c) => {
        const info = types.data.find((t) => t.name === c.type);
        return info ? <CredentialSelect key={c.type} node={node} type={info} all={credentials.data ?? []} /> : null;
      })}
    </div>
  );
}
