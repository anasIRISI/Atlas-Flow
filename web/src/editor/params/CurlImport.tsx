import { useMemo, useState } from 'react';
import { CircleAlert, ClipboardPaste, KeyRound, TriangleAlert, X } from 'lucide-react';
import type { NodeProperty } from '@flowforge/shared';
import { Button } from '../../components/ui/Button';
import { errorMessage } from '../../lib/api';
import { useSaveCredential } from '../../lib/credentials-api';
import { toast } from '../../lib/toast';
import { editor, useEditor } from '../store';
import { useNodeEdit } from './context';
import { CurlParseError, curlToHttpParameters, parseCurl, type CurlRequest } from './curl';

function summary(r: CurlRequest): string {
  const parts = [`${r.method} ${r.url}`];
  if (r.query.length) parts.push(`${r.query.length} query parameter${r.query.length === 1 ? '' : 's'}`);
  if (r.headers.length) parts.push(`${r.headers.length} header${r.headers.length === 1 ? '' : 's'}`);
  if (r.body) parts.push(`${r.body.type === 'multipart' ? 'form-data' : r.body.type} body`);
  return parts.join(' · ');
}

function Dialog({ nodeName, onClose }: { nodeName: string; onClose(): void }) {
  const node = useEditor((s) => s.nodes.find((n) => n.name === nodeName));
  const save = useSaveCredential();
  const [text, setText] = useState('');
  const [asCredential, setAsCredential] = useState(true);
  const parsed = useMemo(() => {
    if (!text.trim()) return {};
    try {
      return { request: parseCurl(text) };
    } catch (err) {
      return { error: err instanceof CurlParseError ? err.message : 'This command could not be read' };
    }
  }, [text]);
  const request = parsed.request;

  const run = async () => {
    if (!request || !node) return;
    let credentials = node.credentials;
    const auth = request.auth;
    if (auth && asCredential) {
      try {
        const host = new URL(request.url).host;
        const created = await save.mutateAsync(
          auth.type === 'bearer'
            ? { name: `cURL import (${host})`, type: 'httpBearerAuth', data: { token: auth.token } }
            : { name: `cURL import (${host})`, type: 'httpBasicAuth', data: { user: auth.user, password: auth.password } },
        );
        credentials = { ...(credentials ?? {}), [created.type]: { id: created.id, name: created.name } };
      } catch (err) {
        toast.error('Could not save the credential', errorMessage(err));
        return;
      }
    }
    editor.updateNode(node.name, { parameters: curlToHttpParameters(request, { inlineAuth: !asCredential }), credentials });
    toast.success('cURL command imported', request.warnings.length ? `${request.warnings.length} option(s) could not be imported.` : `${request.method} ${new URL(request.url).host}`);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[58] flex items-center justify-center bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[90vh] w-[640px] max-w-[94vw] animate-fade-in flex-col overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl" role="dialog" aria-label="Import cURL" data-testid="curl-dialog">
        <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
          <ClipboardPaste size={18} className="text-accent-hover" />
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold">Import cURL command</h2>
            <p className="text-[12px] text-subtle">Paste a command from API docs or from your browser ("Copy as cURL"). It replaces the settings of this node.</p>
          </div>
          <button type="button" onClick={onClose} title="Close" className="rounded p-1.5 text-subtle hover:bg-panel-3 hover:text-fg">
            <X size={16} />
          </button>
        </header>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-5">
          <textarea
            autoFocus
            spellCheck={false}
            data-testid="curl-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`curl -X POST https://api.example.com/orders \\\n  -H "Content-Type: application/json" \\\n  -d '{"item": "pen"}'`}
            className="h-44 w-full resize-y rounded-md border border-line-strong bg-panel-2 p-3 font-mono text-[12.5px] leading-relaxed text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
          />
          {parsed.error && (
            <div className="flex gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-[#ffb4b2]" data-testid="curl-error">
              <CircleAlert size={15} className="mt-0.5 shrink-0" /> {parsed.error}
            </div>
          )}
          {request && (
            <div className="rounded-md border border-line bg-panel-2/60 px-3 py-2 text-[12.5px]" data-testid="curl-summary">
              <span className="break-all font-mono text-[12px]">{summary(request)}</span>
            </div>
          )}
          {request?.auth && (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line bg-panel-2/50 px-3 py-2.5" data-testid="curl-credential">
              <input type="checkbox" className="mt-0.5 accent-[#f0592a]" checked={asCredential} onChange={(e) => setAsCredential(e.target.checked)} data-testid="curl-as-credential" />
              <span className="text-[12.5px]">
                <span className="flex items-center gap-1.5 font-medium">
                  <KeyRound size={13} className="text-accent-hover" /> Save the {request.auth.type === 'bearer' ? 'token' : 'login'} as an encrypted credential (recommended)
                </span>
                <span className="block text-subtle">Otherwise it is written into the node as an Authorization header, visible to anyone who opens or exports the workflow.</span>
              </span>
            </label>
          )}
          {request?.warnings.map((w) => (
            <div key={w} className="flex items-start gap-1.5 text-[12px] text-warning" data-testid="curl-warning">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" /> {w}
            </div>
          ))}
        </div>
        <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!request} loading={save.isPending} onClick={() => void run()} data-testid="curl-import">
            Import
          </Button>
        </footer>
      </div>
    </div>
  );
}

/** "Import cURL" button of the HTTP Request node (property type `curlImport`). */
export function CurlImport({ property }: { property: NodeProperty }) {
  const { nodeName } = useNodeEdit();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="curl-import-open"
        onClick={() => setOpen(true)}
        className="flex h-8 items-center justify-center gap-1.5 self-start rounded-md border border-line-strong bg-panel-2 px-3 text-[12.5px] font-medium text-muted hover:border-accent hover:text-fg"
      >
        <ClipboardPaste size={13} /> {property.displayName}
      </button>
      {open && <Dialog nodeName={nodeName} onClose={() => setOpen(false)} />}
    </>
  );
}
