import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ChevronLeft, History, Keyboard, MessageSquarePlus, Play, Save, Settings2, Square } from 'lucide-react';
import { Button } from '../components/ui/Button';
import { cn } from '../components/ui/cn';
import { executeWorkflow, save, stopCurrent } from './actions';
import { ActiveToggle } from './ActiveToggle';
import { HistoryDrawer } from './HistoryDrawer';
import { editor, isRunning, useEditor } from './store';

function WorkflowName() {
  const name = useEditor((s) => s.name);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== name) editor.setName(draft.trim());
    else setDraft(name);
  };
  return editing ? (
    <input
      autoFocus
      data-testid="workflow-name-input"
      className="h-8 w-72 rounded border border-accent bg-panel-2 px-2 text-[14px] font-medium focus:outline-none"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          setDraft(name);
          setEditing(false);
        }
      }}
    />
  ) : (
    <button type="button" data-testid="workflow-name" title="Rename" onClick={() => setEditing(true)} className="max-w-[360px] truncate rounded px-1.5 py-1 text-[14px] font-medium hover:bg-panel-3">
      {name}
    </button>
  );
}

export function TopBar() {
  const dirty = useEditor((s) => s.dirty);
  const status = useEditor((s) => s.execution.status);
  const running = isRunning(status);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const doSave = async (n?: string) => {
    setSaving(true);
    await save(n);
    setSaving(false);
  };
  return (
    <header className="flex min-h-14 flex-wrap py-2 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
      <Link to="/workflows" className="flex items-center gap-1 rounded px-1.5 py-1 text-[12.5px] text-muted hover:bg-panel-3 hover:text-fg">
        <ChevronLeft size={16} /> Workflows
      </Link>
      <span className="text-subtle">/</span>
      <WorkflowName />
      <span
        data-testid="save-state"
        data-dirty={dirty ? 'true' : 'false'}
        className={cn('flex items-center gap-1.5 text-[12px]', dirty ? 'text-warning' : 'text-subtle')}
      >
        <span className={cn('size-1.5 rounded-full', dirty ? 'bg-warning' : 'bg-success')} />
        {dirty ? 'Non enregistré' : 'Enregistré'}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <ActiveToggle />
        <div className="mx-1 h-5 w-px bg-line" />
        <button
          type="button"
          title="Workflow settings"
          data-testid="open-settings"
          onClick={() => editor.setUi({ settingsOpen: true })}
          className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-fg"
        >
          <Settings2 size={16} />
        </button>
        <button
          type="button"
          title="Historique des versions"
          data-testid="open-history"
          onClick={() => setHistoryOpen((o) => !o)}
          className={cn('rounded p-2 hover:bg-panel-3 hover:text-fg', historyOpen ? 'text-fg' : 'text-subtle')}
        >
          <History size={16} />
        </button>
        <button type="button" title="Keyboard shortcuts (?)" onClick={() => editor.setUi({ helpOpen: true })} className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-fg">
          <Keyboard size={16} />
        </button>
        <Button
          variant="secondary"
          size="sm"
          icon={<Save size={14} />}
          loading={saving}
          data-testid="save-workflow"
          title="Enregistrer (Maj + clic : ajouter une note)"
          onClick={(e) => (e.shiftKey ? setNoteOpen(true) : void doSave())}
        >
          Enregistrer
        </Button>
        <button type="button" title="Save with note…" data-testid="save-with-note" onClick={() => setNoteOpen(true)} className="rounded p-2 text-subtle hover:bg-panel-3 hover:text-fg">
          <MessageSquarePlus size={16} />
        </button>
        {running ? (
          <Button variant="danger" size="sm" icon={<Square size={13} />} data-testid="stop-execution" onClick={() => void stopCurrent()}>
            Arrêter
          </Button>
        ) : (
          <Button size="sm" icon={<Play size={14} />} data-testid="execute-workflow" onClick={() => void executeWorkflow()}>
            Exécuter
          </Button>
        )}
      </div>
      {historyOpen && <HistoryDrawer onClose={() => setHistoryOpen(false)} />}
      {noteOpen && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && setNoteOpen(false)}>
          <form
            className="w-[420px] max-w-[92vw] rounded-xl border border-line-strong bg-panel p-5 shadow-2xl"
            onSubmit={(e) => {
              e.preventDefault();
              setNoteOpen(false);
              void doSave(note.trim());
              setNote('');
            }}
          >
            <h2 className="text-[16px] font-semibold">Enregistrer avec une note</h2>
            <p className="mt-1 text-[13px] text-muted">La note apparaît dans l'historique des versions.</p>
            <input
              autoFocus
              data-testid="version-note"
              maxLength={200}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Qu'as-tu modifié ?"
              className="mt-3 h-9 w-full rounded border border-line-strong bg-panel-2 px-2 text-[13px] focus:border-accent focus:outline-none"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setNoteOpen(false)}>
                Annuler
              </Button>
              <Button type="submit">Enregistrer</Button>
            </div>
          </form>
        </div>
      )}
    </header>
  );
}
