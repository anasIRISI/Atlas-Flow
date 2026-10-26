import { useState } from 'react';
import { CircleAlert, KeyRound } from 'lucide-react';
import type { SerializedError } from '@flowforge/shared';
import { Button } from '../../components/ui/Button';
import { CredentialDialog } from '../../credentials/CredentialDialog';
import { useCredentials } from '../../lib/credentials-api';
import { useNodeEdit } from '../params/context';
import { editor, useEditor } from '../store';

/** Opens the credential behind a credential error: the failing one for editing, or a new one of the missing type. */
function OpenCredentials({ error }: { error: SerializedError }) {
  const [open, setOpen] = useState(false);
  const credentials = useCredentials();
  const { nodeName } = useNodeEdit();
  const node = useEditor((s) => s.nodes.find((n) => n.name === (error.node ?? nodeName)));
  const failing = error.credentialId ? credentials.data?.find((c) => c.id === error.credentialId) : undefined;
  return (
    <>
      <Button size="sm" variant="secondary" icon={<KeyRound size={14} />} className="self-start" onClick={() => setOpen(true)} data-testid="open-credentials">
        Open Credentials
      </Button>
      {open && (
        <CredentialDialog
          type={error.credentialType}
          credential={failing}
          onClose={() => setOpen(false)}
          onSaved={(saved) => {
            // A credential created to fix a missing one is selected on the node that failed.
            if (!failing && node) editor.updateNode(node.name, { credentials: { ...(node.credentials ?? {}), [saved.type]: { id: saved.id, name: saved.name } } });
          }}
        />
      )}
    </>
  );
}

/** Node error with message, details, hint — and "Open Credentials" for credential problems. */
export function ErrorCard({ error }: { error: SerializedError }) {
  return (
    <div className="m-3 flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3" data-testid="node-error">
      <div className="flex items-start gap-2 text-[13px] font-semibold text-[#ffb4b2]">
        <CircleAlert size={16} className="mt-0.5 shrink-0" />
        <span data-testid="node-error-message">{error.message}</span>
      </div>
      {error.description && <p className="text-[12.5px] text-muted">{error.description}</p>}
      {error.expression && <code className="rounded bg-panel-2 px-2 py-1 font-mono text-[12px] text-[#9cc8ff]">{`{{ ${error.expression} }}`}</code>}
      {error.itemIndex !== undefined && <p className="text-[12px] text-subtle">Item {error.itemIndex}</p>}
      {error.hint && <p className="text-[12.5px] text-fg">💡 {error.hint}</p>}
      {error.credentialType && <OpenCredentials error={error} />}
    </div>
  );
}
