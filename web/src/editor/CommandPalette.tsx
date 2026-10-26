import { Command } from 'cmdk';
import { useNavigate } from 'react-router';
import { History, KeyRound, Keyboard, LayoutDashboard, LayoutGrid, Play, Redo2, Save, Settings, StickyNote, Undo2, Workflow } from 'lucide-react';
import type { NodeTypeInfo } from '@flowforge/shared';
import { iconFor } from '../lib/node-types';
import { executeWorkflow, save } from './actions';
import { addFromCreator } from './creator/NodeCreator';
import { editor, useEditor } from './store';

function Item({ onSelect, icon, children, shortcut, value }: { onSelect(): void; icon: React.ReactNode; children: React.ReactNode; shortcut?: string; value?: string }) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] text-muted data-[selected=true]:bg-panel-3 data-[selected=true]:text-fg"
    >
      <span className="flex size-5 items-center justify-center text-subtle">{icon}</span>
      <span className="flex-1">{children}</span>
      {shortcut && <kbd className="rounded border border-line bg-panel-2 px-1.5 text-[11px] text-subtle">{shortcut}</kbd>}
    </Command.Item>
  );
}

/** Cmd/Ctrl+K: actions, add any node, go to a page. */
export function CommandPalette({ types, onAutoLayout, onAddSticky }: { types: NodeTypeInfo[]; onAutoLayout(): void; onAddSticky(): void }) {
  const open = useEditor((s) => s.paletteOpen);
  const navigate = useNavigate();
  if (!open) return null;
  const close = () => editor.setUi({ paletteOpen: false });
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  const group = 'px-1 pb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-subtle';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <Command
        label="Command palette"
        data-testid="command-palette"
        className="w-[560px] max-w-[92vw] animate-fade-in overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl shadow-black/60"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
      >
        <Command.Input
          autoFocus
          data-testid="command-palette-input"
          placeholder="Type a command or a node name…"
          className="h-12 w-full border-b border-line bg-transparent px-4 text-[14px] outline-none placeholder:text-subtle"
        />
        <Command.List className="max-h-[52vh] overflow-y-auto p-1">
          <Command.Empty className="px-4 py-6 text-center text-[13px] text-subtle">Nothing found.</Command.Empty>
          <Command.Group heading="Actions" className={group}>
            <Item icon={<Play size={15} />} shortcut="Ctrl+↵" onSelect={run(() => void executeWorkflow())}>
              Execute workflow
            </Item>
            <Item icon={<Save size={15} />} shortcut="Ctrl+S" onSelect={run(() => void save())}>
              Save workflow
            </Item>
            <Item icon={<LayoutGrid size={15} />} shortcut="Shift+Alt+T" onSelect={run(onAutoLayout)}>
              Tidy up (auto-layout)
            </Item>
            <Item icon={<StickyNote size={15} />} shortcut="Shift+S" onSelect={run(onAddSticky)}>
              Add sticky note
            </Item>
            <Item icon={<Undo2 size={15} />} shortcut="Ctrl+Z" onSelect={run(() => editor.undo())}>
              Undo
            </Item>
            <Item icon={<Redo2 size={15} />} shortcut="Ctrl+Shift+Z" onSelect={run(() => editor.redo())}>
              Redo
            </Item>
            <Item icon={<Keyboard size={15} />} shortcut="?" onSelect={run(() => editor.setUi({ helpOpen: true }))}>
              Keyboard shortcuts
            </Item>
          </Command.Group>
          <Command.Group heading="Add node" className={group}>
            {types
              .filter((t) => t.group !== 'note')
              .map((t) => {
                const Icon = iconFor(t.icon);
                return (
                  <Item key={t.type} value={`add ${t.displayName} ${(t.keywords ?? []).join(' ')}`} icon={<Icon size={15} style={{ color: t.defaults.color }} />} onSelect={run(() => addFromCreator(t))}>
                    Add {t.displayName}
                  </Item>
                );
              })}
          </Command.Group>
          <Command.Group heading="Go to" className={group}>
            <Item icon={<LayoutDashboard size={15} />} onSelect={run(() => navigate('/home'))}>
              Overview
            </Item>
            <Item icon={<Workflow size={15} />} onSelect={run(() => navigate('/workflows'))}>
              Workflows
            </Item>
            <Item icon={<History size={15} />} onSelect={run(() => navigate('/executions'))}>
              Executions
            </Item>
            <Item icon={<KeyRound size={15} />} onSelect={run(() => navigate('/credentials'))}>
              Credentials
            </Item>
            <Item icon={<Settings size={15} />} onSelect={run(() => navigate('/settings'))}>
              Settings
            </Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
