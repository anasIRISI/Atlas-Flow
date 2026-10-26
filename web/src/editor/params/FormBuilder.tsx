import { useState, type DragEvent } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, GripVertical, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import {
  FIELD_TYPES_WITH_OPTIONS,
  FORM_FIELD_TYPES,
  FORM_THEMES,
  formBinaryKey,
  isFormTheme,
  type FormFieldDef,
  type FormFieldType,
  type FormTheme,
} from '@flowforge/shared';
import { cn } from '../../components/ui/cn';
import { Toggle } from '../../components/ui/Toggle';
import { iconFor } from '../../lib/node-types';
import { editor, useEditor } from '../store';
import { useNodeEdit } from './context';
import { inputClass } from './Field';
import { changeType, fieldProblems, moveField, newField, readFields } from './form-fields';

const DRAG_TYPE = 'application/x-flowforge-formfield';
const typeInfo = (type: FormFieldType | undefined) => FORM_FIELD_TYPES.find((t) => t.value === (type ?? 'text')) ?? FORM_FIELD_TYPES[0]!;

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-subtle">{hint}</span>}
    </label>
  );
}

function OptionsEditor({ field, onChange, testId }: { field: FormFieldDef; onChange(f: FormFieldDef): void; testId: string }) {
  const options = field.fieldOptions?.values ?? [];
  const set = (values: { option: string }[]) => onChange({ ...field, fieldOptions: { values } });
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11.5px] font-medium text-muted">Options</span>
      {options.map((o, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input
            className={inputClass}
            data-testid={`${testId}-option-${i}`}
            value={o.option ?? ''}
            placeholder={`Option ${i + 1}`}
            onChange={(e) => set(options.map((x, j) => (j === i ? { option: e.target.value } : x)))}
          />
          <button type="button" title="Remove option" className="rounded p-1 text-subtle hover:text-danger" onClick={() => set(options.filter((_, j) => j !== i))}>
            <X size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        data-testid={`${testId}-option-add`}
        onClick={() => set([...options, { option: `Option ${options.length + 1}` }])}
        className="flex h-7 items-center justify-center gap-1 rounded-md border border-dashed border-line-strong text-[12px] text-muted hover:border-accent hover:text-fg"
      >
        <Plus size={12} /> Add option
      </button>
      {field.fieldType === 'checkbox' && <span className="text-[11px] text-subtle">Without options it is one single checkbox (yes / no), e.g. "I accept the rules".</span>}
    </div>
  );
}

function FieldEditor({ field, index, onChange, testId }: { field: FormFieldDef; index: number; onChange(f: FormFieldDef): void; testId: string }) {
  const type = field.fieldType ?? 'text';
  const set = (patch: Partial<FormFieldDef>) => onChange({ ...field, ...patch });
  const hidden = type === 'hiddenField';
  return (
    <div className="grid gap-3 border-t border-line p-3">
      <div className="grid grid-cols-[1fr_150px] gap-2">
        <Labeled label={hidden ? 'Label (only shown here)' : 'Label'}>
          <input className={inputClass} data-testid={`${testId}-label`} value={field.fieldLabel} autoFocus placeholder="e.g. Your name" onChange={(e) => set({ fieldLabel: e.target.value })} />
        </Labeled>
        <Labeled label="Type">
          <select className={inputClass} data-testid={`${testId}-type`} value={type} onChange={(e) => onChange(changeType(field, e.target.value as FormFieldType))}>
            {FORM_FIELD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Labeled>
      </div>

      {hidden ? (
        <div className="grid grid-cols-2 gap-2">
          <Labeled label="Name in the output">
            <input className={inputClass} data-testid={`${testId}-fieldName`} value={field.fieldName ?? ''} placeholder="source" onChange={(e) => set({ fieldName: e.target.value })} />
          </Labeled>
          <Labeled label="Value">
            <input className={inputClass} data-testid={`${testId}-fieldValue`} value={field.fieldValue ?? ''} placeholder="e.g. poster" onChange={(e) => set({ fieldValue: e.target.value })} />
          </Labeled>
          <span className="col-span-2 text-[11px] text-subtle">
            Not visible in the form. <code className="rounded bg-panel-2 px-1">?{field.fieldName || 'source'}=…</code> in the form URL overrides the value (handy for one QR code per place).
          </span>
        </div>
      ) : (
        <>
          {FIELD_TYPES_WITH_OPTIONS.includes(type) && <OptionsEditor field={field} onChange={onChange} testId={testId} />}
          {type === 'file' && (
            <div className="grid gap-2">
              <Labeled label="Accepted file types" hint="Empty = any file. Extensions or MIME types, separated by commas.">
                <input className={inputClass} data-testid={`${testId}-accept`} value={field.acceptFileTypes ?? ''} placeholder=".pdf, .jpg, image/*" onChange={(e) => set({ acceptFileTypes: e.target.value })} />
              </Labeled>
              <div className="flex items-center gap-2 text-[12px] text-muted">
                <Toggle checked={field.multipleFiles === true} onChange={(v) => set({ multipleFiles: v })} testId={`${testId}-multiple`} label="Several files" /> Allow several files
              </div>
              <span className="text-[11px] text-subtle">
                The file arrives as binary data in <code className="rounded bg-panel-2 px-1">{formBinaryKey(field, index)}{field.multipleFiles ? '_0' : ''}</code> (use this name to attach it to an email).
              </span>
            </div>
          )}
          {!['file', 'checkbox', 'radio', 'date'].includes(type) && (
            <Labeled label="Placeholder">
              <input className={inputClass} data-testid={`${testId}-placeholder`} value={field.placeholder ?? ''} onChange={(e) => set({ placeholder: e.target.value })} />
            </Labeled>
          )}
          <Labeled label="Help text">
            <input className={inputClass} data-testid={`${testId}-help`} value={field.helpText ?? ''} placeholder="Shown under the field" onChange={(e) => set({ helpText: e.target.value })} />
          </Labeled>
          {type !== 'file' && !(type === 'checkbox' && (field.fieldOptions?.values?.length ?? 0) > 0) && (
            <Labeled label="Default value" hint={type === 'checkbox' ? 'true = checked' : undefined}>
              <input className={inputClass} data-testid={`${testId}-default`} value={field.defaultValue ?? ''} onChange={(e) => set({ defaultValue: e.target.value })} />
            </Labeled>
          )}
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <Toggle checked={field.requiredField === true} onChange={(v) => set({ requiredField: v })} testId={`${testId}-required`} label="Required" /> Required
          </div>
        </>
      )}
    </div>
  );
}

interface Props {
  value: unknown;
  root: Record<string, unknown>;
  onChange(value: unknown): void;
  testId: string;
  displayName: string;
}

/** Visual form builder: add, drag to reorder, edit and delete form elements; pick one of 3 themes. */
export function FormBuilder({ value, root, onChange, testId, displayName }: Props) {
  const { nodeName } = useNodeEdit();
  const node = useEditor((s) => s.nodes.find((n) => n.name === nodeName));
  const fields = readFields(value);
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [drag, setDrag] = useState<{ from: number; insert: number | null } | null>(null);
  const update = (list: FormFieldDef[]) => onChange({ ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}), values: list });
  const theme: FormTheme = isFormTheme(root.formTheme) ? root.formTheme : 'midnight';
  const problems = fieldProblems(fields);

  const move = (from: number, to: number) => {
    update(moveField(fields, from, to));
    setOpen((o) => (o === from ? Math.max(0, Math.min(fields.length - 1, to)) : null));
  };
  const onDragOver = (e: DragEvent, i: number) => {
    if (!drag || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const box = e.currentTarget.getBoundingClientRect();
    const insert = e.clientY < box.top + box.height / 2 ? i : i + 1;
    if (insert !== drag.insert) setDrag({ ...drag, insert });
  };
  const onDrop = (e: DragEvent) => {
    if (!drag || drag.insert === null) return setDrag(null);
    e.preventDefault();
    move(drag.from, drag.insert > drag.from ? drag.insert - 1 : drag.insert);
    setDrag(null);
  };

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-medium text-muted">{displayName}</span>
        <span className="rounded-full bg-panel-3 px-2 py-0.5 text-[11px] text-muted" data-testid={`${testId}-count`}>
          {fields.length}
        </span>
        {node && (
          <div className="ml-auto flex items-center gap-1.5" role="radiogroup" aria-label="Form theme">
            <span className="text-[11.5px] text-subtle">Theme</span>
            {FORM_THEMES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={theme === t.value}
                title={t.label}
                data-testid={`form-theme-${t.value}`}
                onClick={() => editor.updateParameters(node.name, { ...node.parameters, formTheme: t.value })}
                className={cn('size-6 rounded-full border-2 transition-transform hover:scale-110', theme === t.value ? 'border-accent ring-2 ring-accent/40' : 'border-line-strong')}
                style={{ background: `linear-gradient(135deg, ${t.swatch[0]} 50%, ${t.swatch[1]} 50%)` }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5" onDrop={onDrop} onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && drag && setDrag({ ...drag, insert: null })}>
        {fields.length === 0 && <div className="rounded-md border border-dashed border-line-strong px-3 py-5 text-center text-[12px] text-subtle">The form has no fields yet. Add the first one below.</div>}
        {fields.map((f, i) => {
          const info = typeInfo(f.fieldType);
          const Icon = iconFor(`lucide:${info.icon}`);
          const isOpen = open === i;
          const id = `${testId}-${i}`;
          return (
            <div key={f.id ?? i} className="relative" onDragOver={(e) => onDragOver(e, i)}>
              {drag?.insert === i && <div className="absolute inset-x-0 -top-1 h-0.5 rounded bg-accent" />}
              {drag?.insert === i + 1 && i === fields.length - 1 && <div className="absolute inset-x-0 -bottom-1 h-0.5 rounded bg-accent" />}
              <div className={cn('rounded-md border bg-panel-2/60', isOpen ? 'border-accent/60' : 'border-line', drag?.from === i && 'opacity-40')} data-testid={id} data-label={f.fieldLabel}>
                <div
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, String(i));
                    e.dataTransfer.effectAllowed = 'move';
                    setDrag({ from: i, insert: null });
                  }}
                  onDragEnd={() => setDrag(null)}
                  className="flex cursor-grab items-center gap-2 px-2 py-2 active:cursor-grabbing"
                  data-testid={`${id}-handle`}
                >
                  <GripVertical size={14} className="shrink-0 text-subtle" />
                  <Icon size={15} className="shrink-0 text-accent-hover" />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(isOpen ? null : i)} data-testid={`${id}-toggle`}>
                    <span className={cn('block truncate text-[13px] font-medium', !f.fieldLabel.trim() && 'italic text-warning')}>
                      {f.fieldLabel.trim() || 'No label'}
                      {f.requiredField && <span className="ml-1 text-accent">*</span>}
                    </span>
                    <span className="block truncate text-[11px] text-subtle">{info.label}</span>
                  </button>
                  <button type="button" title="Move up" disabled={i === 0} data-testid={`${id}-up`} onClick={() => move(i, i - 1)} className="rounded p-1 text-subtle hover:bg-panel-3 hover:text-fg disabled:opacity-30">
                    <ArrowUp size={13} />
                  </button>
                  <button type="button" title="Move down" disabled={i === fields.length - 1} data-testid={`${id}-down`} onClick={() => move(i, i + 1)} className="rounded p-1 text-subtle hover:bg-panel-3 hover:text-fg disabled:opacity-30">
                    <ArrowDown size={13} />
                  </button>
                  <button
                    type="button"
                    title="Delete field"
                    data-testid={`${id}-delete`}
                    onClick={() => {
                      update(fields.filter((_, j) => j !== i));
                      setOpen(null);
                    }}
                    className="rounded p-1 text-subtle hover:bg-panel-3 hover:text-danger"
                  >
                    <Trash2 size={13} />
                  </button>
                  <button type="button" title={isOpen ? 'Close' : 'Edit'} onClick={() => setOpen(isOpen ? null : i)} className="rounded p-1 text-subtle hover:bg-panel-3 hover:text-fg">
                    <ChevronDown size={14} className={cn('transition-transform', isOpen && 'rotate-180')} />
                  </button>
                </div>
                {isOpen && <FieldEditor field={f} index={i} testId={id} onChange={(next) => update(fields.map((x, j) => (j === i ? next : x)))} />}
              </div>
            </div>
          );
        })}
      </div>

      {problems.map((p) => (
        <div key={p} className="flex items-start gap-1.5 text-[11.5px] text-warning" data-testid={`${testId}-problem`}>
          <TriangleAlert size={12} className="mt-0.5 shrink-0" /> {p}
        </div>
      ))}

      {adding ? (
        <div className="rounded-md border border-line-strong bg-panel-2 p-2" data-testid={`${testId}-types`}>
          <div className="mb-1.5 flex items-center justify-between px-1 text-[11.5px] text-subtle">
            What do you want to ask?
            <button type="button" onClick={() => setAdding(false)} className="rounded p-0.5 hover:text-fg">
              <X size={13} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1">
            {FORM_FIELD_TYPES.map((t) => {
              const Icon = iconFor(`lucide:${t.icon}`);
              return (
                <button
                  key={t.value}
                  type="button"
                  data-testid={`${testId}-add-${t.value}`}
                  onClick={() => {
                    update([...fields, newField(t.value, fields)]);
                    setOpen(fields.length);
                    setAdding(false);
                  }}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] hover:bg-panel-3"
                >
                  <Icon size={14} className="shrink-0 text-accent-hover" /> {t.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid={`${testId}-add`}
          onClick={() => setAdding(true)}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong text-[12.5px] text-muted hover:border-accent hover:text-fg"
        >
          <Plus size={13} /> Add field
        </button>
      )}
    </div>
  );
}
