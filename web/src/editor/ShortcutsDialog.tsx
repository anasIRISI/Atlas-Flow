import { X } from 'lucide-react';
import { editor, useEditor } from './store';

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl/Cmd + K', 'Command palette'],
  ['Tab', 'Add a node'],
  ['Ctrl/Cmd + Enter', 'Execute workflow'],
  ['Ctrl/Cmd + S', 'Save'],
  ['Ctrl/Cmd + Z', 'Undo'],
  ['Ctrl/Cmd + Shift + Z  /  Ctrl + Y', 'Redo'],
  ['Ctrl/Cmd + C / V', 'Copy / paste nodes (connections between them are kept)'],
  ['Ctrl/Cmd + D', 'Duplicate selected nodes'],
  ['Ctrl/Cmd + A', 'Select all'],
  ['Drag on empty canvas', 'Box select'],
  ['Shift / Ctrl + click', 'Add to selection'],
  ['Delete / Backspace', 'Delete selection'],
  ['Enter', 'Open the selected node'],
  ['D', 'Disable / enable selected nodes'],
  ['Shift + S', 'Add a sticky note'],
  ['Shift + Alt + T', 'Tidy up (auto-layout)'],
  ['Shift + 1', 'Fit view'],
  ['Scroll / middle-drag / Space + drag', 'Move the canvas'],
  ['Ctrl/Cmd + scroll', 'Zoom'],
  ['Esc', 'Close panels'],
  ['?', 'This help'],
  ['← / →', 'Time travel: previous / next step'],
  ['Space', 'Time travel: play / pause'],
  ['Esc (time travel)', 'Leave time travel'],
];

export function ShortcutsDialog() {
  const open = useEditor((s) => s.helpOpen);
  if (!open) return null;
  const close = () => editor.setUi({ helpOpen: false });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="w-[560px] max-w-[92vw] animate-fade-in rounded-xl border border-line-strong bg-panel p-5 shadow-2xl" data-testid="shortcuts-dialog">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold">Keyboard shortcuts</h2>
          <button type="button" onClick={close} className="rounded p-1 text-subtle hover:bg-panel-3 hover:text-fg" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="grid gap-1.5">
          {SHORTCUTS.map(([keys, label]) => (
            <div key={keys} className="flex items-center justify-between gap-4 text-[13px]">
              <span className="text-muted">{label}</span>
              <kbd className="whitespace-nowrap rounded border border-line bg-panel-2 px-2 py-0.5 font-mono text-[11.5px] text-fg">{keys}</kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
