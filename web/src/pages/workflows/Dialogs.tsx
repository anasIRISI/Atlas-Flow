import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Check, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import type { Tag } from '@flowforge/shared';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { errorMessage } from '../../lib/api';
import { toast } from '../../lib/toast';
import { useImportWorkflow, useTagMutations, useTags } from '../../lib/workflows-api';

export function Overlay({ children, label, onClose, testid }: { children: React.ReactNode; label: string; onClose(): void; testid: string }) {
  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[86vh] w-[560px] max-w-[94vw] animate-fade-in flex-col overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl" role="dialog" aria-label={label} data-testid={testid}>
        {children}
      </div>
    </div>
  );
}

function Header({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose(): void }) {
  return (
    <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
      <div className="flex-1">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {subtitle && <p className="text-[12px] text-subtle">{subtitle}</p>}
      </div>
      <button type="button" onClick={onClose} title="Close" className="rounded p-1.5 text-subtle hover:bg-panel-3 hover:text-fg">
        <X size={16} />
      </button>
    </header>
  );
}

/** Import a workflow JSON from a file or pasted text. */
export function ImportDialog({ onClose }: { onClose(): void }) {
  const navigate = useNavigate();
  const importer = useImportWorkflow();
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ id: string; name: string; missing: string[]; warnings: string[] }>();
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = (source = text) => {
    setError(undefined);
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      setError('This is not valid JSON. Paste the content of an exported workflow file.');
      return;
    }
    importer.mutate(parsed, {
      onSuccess: (res) => {
        const missing = res.missingCredentials.map((m) => `${m.node}: ${m.type} "${m.name}"`);
        if (!missing.length && !res.warnings.length) {
          toast.success('Workflow imported', `"${res.name}" is ready to edit.`);
          navigate(`/workflow/${res.id}`);
        } else setResult({ id: res.id, name: res.name, missing, warnings: res.warnings });
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) return setError('This file is too large (max 20 MB).');
    const content = await file.text();
    setText(content);
    submit(content);
  };

  return (
    <Overlay label="Import workflow" onClose={onClose} testid="import-dialog">
      <Header title="Import workflow" subtitle="Credentials are never part of a file: the nodes keep a reference you can pick again." onClose={onClose} />
      {result ? (
        <div className="flex flex-col gap-3 p-5" data-testid="import-result">
          <p className="text-[13px]">
            Imported as <strong>{result.name}</strong>.
          </p>
          {result.missing.length > 0 && (
            <Alert>
              <div data-testid="import-missing">
                These credentials do not exist here yet. Create them in Credentials, then select them on the node:
                <ul className="mt-1 list-disc pl-5">{result.missing.map((m) => <li key={m}>{m}</li>)}</ul>
              </div>
            </Alert>
          )}
          {result.warnings.length > 0 && (
            <Alert>
              <ul className="list-disc pl-5">{result.warnings.map((m) => <li key={m}>{m}</li>)}</ul>
            </Alert>
          )}
          <div className="flex justify-end">
            <Button onClick={() => navigate(`/workflow/${result.id}`)} data-testid="import-open">
              Open workflow
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-5">
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" data-testid="import-file" onChange={(e) => void onFile(e.target.files?.[0])} />
          <Button variant="secondary" icon={<Upload size={15} />} onClick={() => fileRef.current?.click()} loading={importer.isPending}>
            Choose a .json file
          </Button>
          <div className="text-center text-[12px] text-subtle">or paste the JSON</div>
          <textarea
            data-testid="import-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder='{ "name": "My workflow", "nodes": [ … ], "connections": { … } }'
            className="h-48 w-full resize-none rounded-md border border-line-strong bg-panel-2 p-3 font-mono text-[12px] focus:border-accent focus:outline-none"
          />
          {error && (
            <Alert>
              <span data-testid="import-error">{error}</span>
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!text.trim()} loading={importer.isPending} onClick={() => submit()} data-testid="import-submit">
              Import
            </Button>
          </div>
        </div>
      )}
    </Overlay>
  );
}

/** Create, rename and delete tags. */
export function TagManager({ onClose }: { onClose(): void }) {
  const tags = useTags();
  const m = useTagMutations();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string }>();
  const fail = (title: string) => (err: unknown) => toast.error(title, errorMessage(err));

  const add = () => {
    const n = name.trim();
    if (!n) return;
    m.create.mutate(n, { onSuccess: () => setName(''), onError: fail('Could not create the tag') });
  };

  return (
    <Overlay label="Manage tags" onClose={onClose} testid="tag-manager">
      <Header title="Tags" subtitle="Group workflows with labels, then filter the list by them." onClose={onClose} />
      <div className="flex flex-col gap-3 p-5">
        <div className="flex gap-2">
          <input
            data-testid="tag-new-input"
            value={name}
            maxLength={32}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="New tag name"
            className="h-9 flex-1 rounded-md border border-line-strong bg-panel-2 px-3 text-[13px] focus:border-accent focus:outline-none"
          />
          <Button icon={<Plus size={15} />} onClick={add} loading={m.create.isPending} disabled={!name.trim()} data-testid="tag-create">
            Create
          </Button>
        </div>
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto" data-testid="tag-list">
          {tags.isPending ? (
            <Spinner />
          ) : tags.isError ? (
            <Alert>{errorMessage(tags.error)}</Alert>
          ) : tags.data.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-subtle">No tags yet. Create the first one above.</p>
          ) : (
            tags.data.map((t: Tag) => (
              <div key={t.id} className="flex items-center gap-2 rounded-md border border-line bg-panel-2/60 px-3 py-1.5" data-testid="tag-row" data-name={t.name}>
                {editing?.id === t.id ? (
                  <input
                    autoFocus
                    data-testid="tag-rename-input"
                    value={editing.name}
                    maxLength={32}
                    onChange={(e) => setEditing({ id: t.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setEditing(undefined);
                      if (e.key === 'Enter' && editing.name.trim()) m.rename.mutate({ id: t.id, name: editing.name.trim() }, { onSuccess: () => setEditing(undefined), onError: fail('Could not rename the tag') });
                    }}
                    className="h-7 flex-1 rounded border border-accent bg-panel-2 px-2 text-[13px] focus:outline-none"
                  />
                ) : (
                  <span className="flex-1 truncate text-[13px]">{t.name}</span>
                )}
                <span className="text-[11.5px] text-subtle">{t.usageCount ?? 0} workflow{t.usageCount === 1 ? '' : 's'}</span>
                <button type="button" title="Rename" onClick={() => setEditing({ id: t.id, name: t.name })} className="rounded p-1.5 text-subtle hover:bg-panel-3 hover:text-fg">
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  title="Delete"
                  data-testid="tag-delete"
                  onClick={() => m.remove.mutate(t.id, { onError: fail('Could not delete the tag') })}
                  className="rounded p-1.5 text-subtle hover:bg-panel-3 hover:text-danger"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </Overlay>
  );
}

/** Pick the tags of one workflow (toggle list + quick create). */
export function TagPicker({ workflowId, selected, name, onClose }: { workflowId: string; selected: string[]; name: string; onClose(): void }) {
  const tags = useTags();
  const m = useTagMutations();
  const [ids, setIds] = useState(selected);
  const [newName, setNewName] = useState('');
  const fail = (title: string) => (err: unknown) => toast.error(title, errorMessage(err));

  const save = (next: string[]) => {
    const previous = ids;
    setIds(next);
    m.assign.mutate({ id: workflowId, tagIds: next }, { onError: (err) => { setIds(previous); fail('Could not save the tags')(err); } });
  };
  const toggle = (id: string) => save(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  const createAndAdd = () => {
    const n = newName.trim();
    if (!n) return;
    m.create.mutate(n, { onSuccess: (tag) => { setNewName(''); save([...ids, tag.id]); }, onError: fail('Could not create the tag') });
  };

  return (
    <Overlay label="Workflow tags" onClose={onClose} testid="tag-picker">
      <Header title="Tags" subtitle={name} onClose={onClose} />
      <div className="flex flex-col gap-3 p-5">
        <div className="flex gap-2">
          <input
            data-testid="tag-picker-input"
            value={newName}
            maxLength={32}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createAndAdd()}
            placeholder="Create a tag and add it"
            className="h-9 flex-1 rounded-md border border-line-strong bg-panel-2 px-3 text-[13px] focus:border-accent focus:outline-none"
          />
          <Button icon={<Plus size={15} />} onClick={createAndAdd} disabled={!newName.trim()} loading={m.create.isPending} data-testid="tag-picker-add">
            Add
          </Button>
        </div>
        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {tags.isPending ? (
            <Spinner />
          ) : tags.isError ? (
            <Alert>{errorMessage(tags.error)}</Alert>
          ) : tags.data.length === 0 ? (
            <p className="py-3 text-center text-[13px] text-subtle">No tags yet.</p>
          ) : (
            tags.data.map((t) => (
              <button
                key={t.id}
                type="button"
                data-testid="tag-option"
                data-name={t.name}
                aria-pressed={ids.includes(t.id)}
                onClick={() => toggle(t.id)}
                className="flex items-center gap-2 rounded-md px-3 py-1.5 text-left text-[13px] hover:bg-panel-3"
              >
                <span className={`grid size-4 place-items-center rounded border ${ids.includes(t.id) ? 'border-accent bg-accent text-white' : 'border-line-strong'}`}>{ids.includes(t.id) && <Check size={11} />}</span>
                {t.name}
              </button>
            ))
          )}
        </div>
        <div className="flex justify-end">
          <Button onClick={onClose} data-testid="tag-picker-done">
            Done
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
