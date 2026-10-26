import type { OnErrorMode, WorkflowNode } from '@flowforge/shared';
import { editor } from '../store';
import { inputClass } from '../params/Field';
import { Toggle } from '../params/ParameterList';

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] text-fg">{label}</span>
        {children}
      </div>
      {hint && <p className="text-[11.5px] text-subtle">{hint}</p>}
    </div>
  );
}

/** Engine settings shared by every node (not part of the node's own schema). */
export function NodeSettings({ node, isTrigger }: { node: WorkflowNode; isTrigger: boolean }) {
  const set = (patch: Partial<WorkflowNode>, key?: string) => editor.updateNode(node.name, patch, key);
  return (
    <div className="flex flex-col gap-5" data-testid="node-settings">
      <Row label="Always Output Data" hint="If the node outputs nothing, output one empty item so the next nodes still run.">
        <Toggle testId="setting-alwaysOutputData" checked={node.alwaysOutputData === true} onChange={(v) => set({ alwaysOutputData: v || undefined })} />
      </Row>
      {!isTrigger && (
        <Row label="Execute Once" hint="Only process the first input item.">
          <Toggle testId="setting-executeOnce" checked={node.executeOnce === true} onChange={(v) => set({ executeOnce: v || undefined })} />
        </Row>
      )}
      <Row label="Retry On Fail">
        <Toggle testId="setting-retryOnFail" checked={node.retryOnFail === true} onChange={(v) => set({ retryOnFail: v || undefined })} />
      </Row>
      {node.retryOnFail && (
        <div className="grid grid-cols-2 gap-3 rounded-md border border-line bg-panel-2/60 p-3">
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Max Tries (1–5)
            <input
              className={inputClass}
              type="number"
              min={1}
              max={5}
              value={node.maxTries ?? 3}
              onChange={(e) => set({ maxTries: Math.min(5, Math.max(1, Number(e.target.value) || 1)) }, 'maxTries')}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            Wait Between Tries (ms)
            <input
              className={inputClass}
              type="number"
              min={0}
              max={5000}
              step={100}
              value={node.waitBetweenTries ?? 1000}
              onChange={(e) => set({ waitBetweenTries: Math.min(5000, Math.max(0, Number(e.target.value) || 0)) }, 'wait')}
            />
          </label>
        </div>
      )}
      {!isTrigger && (
        <Row label="On Error">
          <select
            className={`${inputClass} w-64`}
            data-testid="setting-onError"
            value={node.onError ?? 'stopWorkflow'}
            onChange={(e) => set({ onError: e.target.value === 'stopWorkflow' ? undefined : (e.target.value as OnErrorMode) })}
          >
            <option value="stopWorkflow">Stop Workflow</option>
            <option value="continueRegularOutput">Continue</option>
            <option value="continueErrorOutput">Continue (using error output)</option>
          </select>
        </Row>
      )}
      <Row label="Disabled" hint="A disabled node passes its input through unchanged.">
        <Toggle testId="setting-disabled" checked={node.disabled === true} onChange={() => editor.toggleDisabled([node.name])} />
      </Row>
      <div className="flex flex-col gap-1">
        <span className="text-[13px] text-fg">Notes</span>
        <textarea
          className={`${inputClass} h-24 py-1.5`}
          placeholder="Notes about this node (shown in the node panel)"
          value={node.notes ?? ''}
          onChange={(e) => set({ notes: e.target.value || undefined }, 'notes')}
        />
      </div>
    </div>
  );
}
