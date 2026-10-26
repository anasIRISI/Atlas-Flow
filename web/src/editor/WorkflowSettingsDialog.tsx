import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { WorkflowSettings } from '@flowforge/shared';
import { Button } from '../components/ui/Button';
import { useWorkflows } from '../lib/workflows-api';
import { inputClass } from './params/Field';
import { editor, useEditor } from './store';

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[13px] font-medium">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] text-subtle">{hint}</span>}
    </label>
  );
}

/** Workflow settings: timezone, timeout, error workflow, which production executions to keep. */
export function WorkflowSettingsDialog() {
  const open = useEditor((s) => s.settingsOpen);
  const current = useEditor((s) => s.settings);
  const workflowId = useEditor((s) => s.workflowId);
  const workflows = useWorkflows();
  const [draft, setDraft] = useState<WorkflowSettings>(current);
  useEffect(() => {
    if (open) setDraft(current);
  }, [open, current]);
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
    } catch {
      return ['UTC'];
    }
  }, []);
  if (!open) return null;
  const close = () => editor.setUi({ settingsOpen: false });
  const set = (patch: Partial<WorkflowSettings>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="w-[520px] max-w-[94vw] animate-fade-in rounded-xl border border-line-strong bg-panel p-5 shadow-2xl" data-testid="workflow-settings">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold">Workflow settings</h2>
          <button type="button" onClick={close} className="rounded p-1 text-subtle hover:bg-panel-3 hover:text-fg" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-4">
          <Row label="Error workflow" hint="Started (through its Error Trigger) when a production execution of this workflow fails.">
            <select className={inputClass} data-testid="settings-errorWorkflow" value={draft.errorWorkflow ?? ''} onChange={(e) => set({ errorWorkflow: e.target.value || undefined })}>
              <option value="">No error workflow</option>
              {(workflows.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                  {w.id === workflowId ? ' (this workflow)' : ''}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Timezone" hint="Used by schedules, $now and dates. Default: the server's timezone.">
            <select className={inputClass} data-testid="settings-timezone" value={draft.timezone ?? ''} onChange={(e) => set({ timezone: e.target.value || undefined })}>
              <option value="">Default (server timezone)</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Execution timeout (seconds)" hint="0 = the server default (EXECUTION_TIMEOUT_SECONDS).">
            <input
              className={inputClass}
              type="number"
              min={0}
              data-testid="settings-timeout"
              value={draft.executionTimeout ?? 0}
              onChange={(e) => set({ executionTimeout: Math.max(0, Number(e.target.value) || 0) || undefined })}
            />
          </Row>
          <div className="grid grid-cols-2 gap-3">
            <Row label="Save successful production runs">
              <select className={inputClass} value={draft.saveDataSuccessExecution ?? 'all'} onChange={(e) => set({ saveDataSuccessExecution: e.target.value as 'all' | 'none' })}>
                <option value="all">Save</option>
                <option value="none">Do not save</option>
              </select>
            </Row>
            <Row label="Save failed production runs">
              <select className={inputClass} value={draft.saveDataErrorExecution ?? 'all'} onChange={(e) => set({ saveDataErrorExecution: e.target.value as 'all' | 'none' })}>
                <option value="all">Save</option>
                <option value="none">Do not save</option>
              </select>
            </Row>
          </div>
          <p className="text-[11.5px] text-subtle">Manual runs from the editor are always saved (the editor needs their data).</p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            data-testid="settings-save"
            onClick={() => {
              editor.setSettings(draft);
              close();
            }}
          >
            Apply
          </Button>
        </div>
        <p className="mt-2 text-right text-[11.5px] text-subtle">Then save the workflow (Ctrl+S).</p>
      </div>
    </div>
  );
}
