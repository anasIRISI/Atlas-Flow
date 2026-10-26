import { useMemo, type ReactNode } from 'react';
import { Info, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import {
  CONDITION_OPERATORS,
  type Condition,
  type ConditionsValue,
  type ConditionType,
  type FixedCollectionGroup,
  type NodeProperty,
} from '@flowforge/shared';
import { cn } from '../../components/ui/cn';
import { Toggle } from '../../components/ui/Toggle';
import { CodeMirror } from './CodeMirror';
import { codeExtensions } from './cm';
import { isGroupList, isOptionList, isPropertyList, isVisible, setIn, withDefaults, type Values } from './display';
import { CurlImport } from './CurlImport';
import { Field, inputClass, readDropped, type FixedKind } from './Field';
import { FormBuilder } from './FormBuilder';
import { WebhookUrls, WorkflowSelector } from './SpecialInputs';

interface ListProps {
  properties: NodeProperty[];
  /** Values of this level (without defaults). */
  values: Values;
  root: Values;
  onChange(values: Values): void;
  /** Prefix for data-testid, e.g. "param" → "param-mode". */
  testPrefix: string;
}

/** Renders a list of parameters from the node's schema, respecting displayOptions. */
export function ParameterList({ properties, values, root, onChange, testPrefix }: ListProps) {
  const level = useMemo(() => withDefaults(properties, values), [properties, values]);
  return (
    <div className="flex flex-col gap-4">
      {properties
        .filter((p) => !p.typeOptions?.editorHidden && isVisible(p, level, root))
        .map((p) => (
          <ParameterInput
            key={p.name}
            property={p}
            value={values[p.name] === undefined ? p.default : values[p.name]}
            root={root}
            onChange={(v) => onChange(setIn(values, [p.name], v))}
            testId={`${testPrefix}-${p.name}`}
          />
        ))}
    </div>
  );
}

interface InputProps {
  property: NodeProperty;
  value: unknown;
  root: Values;
  onChange(value: unknown): void;
  testId: string;
  compact?: boolean;
}

const kindOf = (type: NodeProperty['type']): FixedKind =>
  type === 'number' ? 'number' : type === 'boolean' ? 'boolean' : type === 'string' || type === 'options' ? 'string' : 'other';

export function ParameterInput({ property: p, value, root, onChange, testId, compact }: InputProps) {
  const field = (children: ReactNode, extra: { noExpression?: boolean; trailing?: ReactNode } = {}) => (
    <Field
      label={p.displayName}
      value={value}
      onChange={onChange}
      kind={kindOf(p.type)}
      description={p.description}
      hint={p.hint}
      required={p.required}
      noExpression={p.noDataExpression || extra.noExpression}
      testId={testId}
      compact={compact}
      trailing={extra.trailing}
    >
      {children}
    </Field>
  );

  switch (p.type) {
    case 'string':
      return field(
        p.typeOptions?.rows && p.typeOptions.rows > 1 ? (
          <textarea
            className={cn(inputClass, 'h-auto py-1.5')}
            rows={p.typeOptions.rows}
            value={String(value ?? '')}
            placeholder={p.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <input
            className={inputClass}
            type={p.typeOptions?.password ? 'password' : 'text'}
            value={String(value ?? '')}
            placeholder={p.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        ),
      );
    case 'number':
      return field(
        <input
          className={inputClass}
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          min={p.typeOptions?.minValue}
          max={p.typeOptions?.maxValue}
          placeholder={p.placeholder}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />,
      );
    case 'boolean':
      return field(<Toggle checked={value === true} onChange={onChange} />);
    case 'options':
      return field(
        <select className={inputClass} value={JSON.stringify(value)} onChange={(e) => onChange(JSON.parse(e.target.value))}>
          {isOptionList(p.options) &&
            p.options.map((o) => (
              <option key={String(o.value)} value={JSON.stringify(o.value)} title={o.description}>
                {o.name}
              </option>
            ))}
        </select>,
      );
    case 'multiOptions': {
      const selected = Array.isArray(value) ? value : [];
      return field(
        <div className="flex flex-wrap gap-1.5">
          {isOptionList(p.options) &&
            p.options.map((o) => {
              const on = selected.includes(o.value);
              return (
                <button
                  key={String(o.value)}
                  type="button"
                  onClick={() => onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
                  className={cn('rounded-full border px-2.5 py-0.5 text-[12px]', on ? 'border-accent bg-accent-soft text-fg' : 'border-line-strong text-muted')}
                >
                  {o.name}
                </button>
              );
            })}
        </div>,
      );
    }
    case 'json':
      return field(<JsonEditor value={value} onChange={onChange} testId={`${testId}-json`} />);
    case 'code':
      return field(
        <CodeMirror
          value={String(value ?? '')}
          onChange={onChange}
          extensions={codeExtensions(p.typeOptions?.language === 'json' ? 'json' : 'javascript')}
          testId={`${testId}-code`}
          className="max-h-[420px] min-h-[180px] overflow-auto"
        />,
        { noExpression: true },
      );
    case 'dateTime':
      return field(<input className={inputClass} type="datetime-local" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />);
    case 'color':
      return field(
        <div className="flex items-center gap-2">
          <input type="color" className="h-8 w-10 rounded border border-line-strong bg-panel-2" value={String(value || '#ff6d3a')} onChange={(e) => onChange(e.target.value)} />
          <input className={inputClass} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
        </div>,
      );
    case 'webhookUrls':
      return <WebhookUrls property={p} />;
    case 'curlImport':
      return <CurlImport property={p} />;
    case 'formFields':
      return <FormBuilder value={value} root={root} onChange={onChange} testId={testId} displayName={p.displayName} />;
    case 'workflowSelector':
      return field(<WorkflowSelector value={value} onChange={onChange} testId={testId} />);
    case 'notice':
      return (
        <div className="flex gap-2 rounded-md border border-info/30 bg-info/8 px-3 py-2 text-[12.5px] text-[#b8d8ff]">
          <Info size={14} className="mt-0.5 shrink-0" />
          {p.displayName}
        </div>
      );
    case 'collection':
      return <CollectionInput property={p} value={value} root={root} onChange={onChange} testId={testId} />;
    case 'fixedCollection':
      return <FixedCollectionInput property={p} value={value} root={root} onChange={onChange} testId={testId} />;
    case 'keyValue':
      return field(<KeyValueInput value={value} onChange={onChange} testId={testId} />, { noExpression: true });
    case 'conditions':
      return (
        <Section title={p.displayName} testId={testId}>
          <ConditionsInput value={value as ConditionsValue} onChange={onChange} testId={testId} />
        </Section>
      );
    case 'assignments':
      return (
        <Section title={p.displayName} testId={testId}>
          <AssignmentsInput value={value} onChange={onChange} testId={testId} />
        </Section>
      );
    default:
      return <FallbackInput property={p} value={value} onChange={onChange} testId={testId} />;
  }
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId: string }) {
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="text-[12.5px] font-medium text-muted">{title}</div>
      {children}
    </div>
  );
}

export { Toggle };

function JsonEditor({ value, onChange, testId }: { value: unknown; onChange(v: unknown): void; testId: string }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  const valid = useMemo(() => {
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  }, [text]);
  return (
    <div className="flex flex-col gap-1">
      <CodeMirror value={text} onChange={onChange} extensions={codeExtensions('json')} testId={testId} className="max-h-[320px] min-h-[96px] overflow-auto" />
      {!valid && <span className="text-[11.5px] text-warning">Not valid JSON yet</span>}
    </div>
  );
}

/** Shown for property types the editor does not know: the value stays editable as JSON. */
function FallbackInput({ property, value, onChange, testId }: { property: NodeProperty; value: unknown; onChange(v: unknown): void; testId: string }) {
  const text = JSON.stringify(value ?? null, null, 2);
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <div className="text-[12.5px] font-medium text-muted">{property.displayName}</div>
      <div className="flex items-center gap-1.5 text-[11.5px] text-warning">
        <TriangleAlert size={12} /> Field type "{property.type}" has no editor yet. Edit it as JSON.
      </div>
      <CodeMirror
        value={text}
        onChange={(v) => {
          try {
            onChange(JSON.parse(v));
          } catch {
            /* keep typing */
          }
        }}
        extensions={codeExtensions('json')}
        className="max-h-[260px] min-h-[80px] overflow-auto"
      />
    </div>
  );
}

function CollectionInput({ property: p, value, root, onChange, testId }: InputProps) {
  const options = isPropertyList(p.options) ? p.options : [];
  const values = (value && typeof value === 'object' ? value : {}) as Values;
  const present = options.filter((o) => values[o.name] !== undefined);
  const missing = options.filter((o) => values[o.name] === undefined);
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="text-[12.5px] font-medium text-muted">{p.displayName}</div>
      {present.length === 0 && <div className="text-[12px] text-subtle">No options set</div>}
      {present.map((o) => (
        <div key={o.name} className="relative rounded-md border border-line bg-panel-2/60 p-2.5 pr-8">
          <ParameterInput
            property={o}
            value={values[o.name]}
            root={root}
            onChange={(v) => onChange(setIn(values, [o.name], v))}
            testId={`${testId}-${o.name}`}
          />
          <button
            type="button"
            title="Remove option"
            className="absolute right-1.5 top-1.5 rounded p-1 text-subtle hover:bg-panel-3 hover:text-fg"
            onClick={() => onChange(setIn(values, [o.name], undefined))}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      {missing.length > 0 && (
        <select
          className={cn(inputClass, 'text-muted')}
          value=""
          data-testid={`${testId}-add`}
          onChange={(e) => {
            const option = options.find((o) => o.name === e.target.value);
            if (option) onChange(setIn(values, [option.name], option.default));
          }}
        >
          <option value="">{p.placeholder ?? 'Add option'}…</option>
          {missing.map((o) => (
            <option key={o.name} value={o.name}>
              {o.displayName}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function FixedCollectionInput({ property: p, value, root, onChange, testId }: InputProps) {
  const groups: FixedCollectionGroup[] = isGroupList(p.options) ? p.options : [];
  const values = (value && typeof value === 'object' ? value : {}) as Values;
  const multiple = p.typeOptions?.multipleValues === true;
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="text-[12.5px] font-medium text-muted">{p.displayName}</div>
      {groups.map((group) => {
        const groupValue = values[group.name];
        const entries = multiple ? (Array.isArray(groupValue) ? (groupValue as Values[]) : []) : groupValue ? [groupValue as Values] : [];
        const update = (next: Values[]) => onChange(setIn(values, [group.name], multiple ? next : next[0]));
        const blank = () => Object.fromEntries(group.values.map((v) => [v.name, v.default]));
        return (
          <div key={group.name} className="flex flex-col gap-2">
            {entries.map((entry, i) => (
              <div key={i} className="relative rounded-md border border-line bg-panel-2/60 p-3 pr-9" data-testid={`${testId}-${group.name}-${i}`}>
                <ParameterList
                  properties={group.values}
                  values={entry}
                  root={root}
                  onChange={(v) => update(entries.map((e, j) => (j === i ? v : e)))}
                  testPrefix={`${testId}-${group.name}-${i}`}
                />
                <button
                  type="button"
                  title="Remove"
                  className="absolute right-2 top-2 rounded p-1 text-subtle hover:bg-panel-3 hover:text-danger"
                  onClick={() => update(entries.filter((_, j) => j !== i))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {(multiple || entries.length === 0) && (
              <button
                type="button"
                data-testid={`${testId}-${group.name}-add`}
                onClick={() => update([...entries, blank()])}
                className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong text-[12.5px] text-muted hover:border-accent hover:text-fg"
              >
                <Plus size={13} /> Add {group.displayName}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function KeyValueInput({ value, onChange, testId }: { value: unknown; onChange(v: unknown): void; testId: string }) {
  const rows = Array.isArray(value) ? (value as Array<{ name: string; value: unknown }>) : [];
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row, i) => (
        <div key={i} className="flex gap-1.5">
          <input className={inputClass} placeholder="Name" value={row.name} onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} />
          <input className={inputClass} placeholder="Value" value={String(row.value ?? '')} onChange={(e) => onChange(rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))} />
          <button type="button" className="rounded px-1.5 text-subtle hover:text-danger" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        data-testid={`${testId}-add`}
        onClick={() => onChange([...rows, { name: '', value: '' }])}
        className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong text-[12.5px] text-muted hover:text-fg"
      >
        <Plus size={13} /> Add pair
      </button>
    </div>
  );
}

// ── Conditions (IF / Switch / Filter) ─────────────────────────────────────────

const TYPE_LABELS: Record<ConditionType, string> = {
  string: 'String',
  number: 'Number',
  dateTime: 'Date & Time',
  boolean: 'Boolean',
  array: 'Array',
  object: 'Object',
};

function ConditionsInput({ value, onChange, testId }: { value: ConditionsValue | undefined; onChange(v: unknown): void; testId: string }) {
  const current: ConditionsValue = value && Array.isArray(value.conditions) ? value : { conditions: [], combinator: 'and' };
  const update = (conditions: Condition[], combinator = current.combinator) => onChange({ ...current, conditions, combinator });
  const blank = (): Condition => ({ id: crypto.randomUUID(), leftValue: '', rightValue: '', operator: { type: 'string', operation: 'equals' } });
  return (
    <div className="flex flex-col gap-2">
      {current.conditions.map((c, i) => {
        const single = CONDITION_OPERATORS[c.operator.type]?.find((o) => o.operation === c.operator.operation)?.singleValue;
        const set = (patch: Partial<Condition>) => update(current.conditions.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        return (
          <div key={c.id ?? i} className="flex flex-col gap-1.5">
            {i > 0 && (
              <select
                className="w-20 self-center rounded border border-line bg-panel-3 px-1 py-0.5 text-[11px] uppercase text-muted"
                value={current.combinator}
                data-testid={`${testId}-combinator`}
                onChange={(e) => update(current.conditions, e.target.value as 'and' | 'or')}
              >
                <option value="and">AND</option>
                <option value="or">OR</option>
              </select>
            )}
            <div className="flex items-start gap-1.5 rounded-md border border-line bg-panel-2/60 p-2" data-testid={`${testId}-${i}`}>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Field label="Value" compact value={c.leftValue} kind="other" onChange={(v) => set({ leftValue: v })} testId={`${testId}-${i}-left`}>
                  <input className={inputClass} placeholder="value 1" value={String(c.leftValue ?? '')} onChange={(e) => set({ leftValue: e.target.value })} />
                </Field>
                <div className={cn('grid gap-1.5', single ? 'grid-cols-1' : 'grid-cols-[minmax(0,3fr)_minmax(0,2fr)]')}>
                <select
                  className={inputClass}
                  data-testid={`${testId}-${i}-operator`}
                  value={`${c.operator.type}:${c.operator.operation}`}
                  onChange={(e) => {
                    const [type, operation] = e.target.value.split(':') as [ConditionType, string];
                    const info = CONDITION_OPERATORS[type].find((o) => o.operation === operation);
                    set({ operator: { type, operation, ...(info?.singleValue ? { singleValue: true } : {}) } });
                  }}
                >
                  {(Object.keys(CONDITION_OPERATORS) as ConditionType[]).map((type) => (
                    <optgroup key={type} label={TYPE_LABELS[type]}>
                      {CONDITION_OPERATORS[type].map((o) => (
                        <option key={o.operation} value={`${type}:${o.operation}`}>
                          {TYPE_LABELS[type]}: {o.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {!single && (
                  <Field label="Value" compact value={c.rightValue} kind="other" onChange={(v) => set({ rightValue: v })} testId={`${testId}-${i}-right`}>
                    <input className={inputClass} placeholder="value 2" value={String(c.rightValue ?? '')} onChange={(e) => set({ rightValue: e.target.value })} />
                  </Field>
                )}
                </div>
              </div>
              <button type="button" title="Remove condition" className="mt-1.5 rounded p-1 text-subtle hover:text-danger" onClick={() => update(current.conditions.filter((_, j) => j !== i))}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        data-testid={`${testId}-add`}
        onClick={() => update([...current.conditions, blank()])}
        className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong text-[12.5px] text-muted hover:border-accent hover:text-fg"
      >
        <Plus size={13} /> Add condition
      </button>
    </div>
  );
}

// ── Assignments (Edit Fields) ─────────────────────────────────────────────────

interface Assignment {
  id: string;
  name: string;
  value: unknown;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
}

function AssignmentsInput({ value, onChange, testId }: { value: unknown; onChange(v: unknown): void; testId: string }) {
  const list = ((value as { assignments?: Assignment[] })?.assignments ?? []) as Assignment[];
  const update = (assignments: Assignment[]) => onChange({ assignments });
  return (
    <div
      className="flex flex-col gap-2"
      onDragOver={(e) => e.dataTransfer.types.includes('application/x-flowforge-field') && e.preventDefault()}
      onDrop={(e) => {
        // Dropping a field on the list (not on a value input) creates a new assignment, like n8n.
        if ((e.target as HTMLElement).closest('[data-assignment-value]')) return;
        const field = readDropped(e);
        if (!field) return;
        e.preventDefault();
        const type = (['string', 'number', 'boolean', 'array', 'object'].includes(field.valueType) ? field.valueType : 'string') as Assignment['type'];
        update([...list, { id: crypto.randomUUID(), name: field.name, value: `=${field.expression}`, type }]);
      }}
    >
      {list.length === 0 && (
        <div className="rounded-md border border-dashed border-line-strong px-3 py-4 text-center text-[12px] text-subtle">
          Drag input fields here, or add a field
        </div>
      )}
      {list.map((a, i) => {
        const set = (patch: Partial<Assignment>) => update(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        return (
          <div key={a.id ?? i} className="flex items-start gap-1.5 rounded-md border border-line bg-panel-2/60 p-2" data-testid={`${testId}-${i}`}>
            <div className="grid min-w-0 flex-1 gap-1.5">
              <div className="flex gap-1.5">
                <input
                  className={inputClass}
                  placeholder="name"
                  data-testid={`${testId}-${i}-name`}
                  value={a.name}
                  onChange={(e) => set({ name: e.target.value })}
                />
                <select className={cn(inputClass, 'w-28')} data-testid={`${testId}-${i}-type`} value={a.type ?? 'string'} onChange={(e) => set({ type: e.target.value as Assignment['type'] })}>
                  <option value="string">String</option>
                  <option value="number">Number</option>
                  <option value="boolean">Boolean</option>
                  <option value="array">Array</option>
                  <option value="object">Object</option>
                </select>
              </div>
              <div data-assignment-value>
                <Field label="Value" compact value={a.value} kind={a.type === 'number' ? 'number' : a.type === 'boolean' ? 'boolean' : 'string'} onChange={(v) => set({ value: v })} testId={`${testId}-${i}-value`}>
                  {a.type === 'boolean' ? (
                    <select className={inputClass} value={String(a.value === true || a.value === 'true')} onChange={(e) => set({ value: e.target.value === 'true' })}>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      className={inputClass}
                      placeholder="value"
                      data-testid={`${testId}-${i}-value-input`}
                      value={typeof a.value === 'string' || typeof a.value === 'number' ? String(a.value) : a.value === undefined ? '' : JSON.stringify(a.value)}
                      onChange={(e) => set({ value: e.target.value })}
                    />
                  )}
                </Field>
              </div>
            </div>
            <button type="button" title="Remove field" className="mt-1.5 rounded p-1 text-subtle hover:text-danger" onClick={() => update(list.filter((_, j) => j !== i))}>
              <Trash2 size={13} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        data-testid={`${testId}-add`}
        onClick={() => update([...list, { id: crypto.randomUUID(), name: '', value: '', type: 'string' }])}
        className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-dashed border-line-strong text-[12.5px] text-muted hover:border-accent hover:text-fg"
      >
        <Plus size={13} /> Add field
      </button>
    </div>
  );
}
