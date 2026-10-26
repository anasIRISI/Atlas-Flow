import { useState, type DragEvent, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { cn } from '../../components/ui/cn';
import { FIELD_DRAG_TYPE, fromExpression, isExpression, toExpression, withDroppedField, type DraggedField } from '../../lib/expressions';
import { ExpressionInput } from './ExpressionInput';

export type FixedKind = 'string' | 'number' | 'boolean' | 'other';

interface FieldProps {
  label: string;
  value: unknown;
  onChange(value: unknown): void;
  kind: FixedKind;
  /** The fixed-value editor. */
  children: ReactNode;
  description?: string;
  hint?: string;
  required?: boolean;
  /** Fields like Code or notices cannot become expressions. */
  noExpression?: boolean;
  testId?: string;
  compact?: boolean;
  trailing?: ReactNode;
}

export function readDropped(e: DragEvent): DraggedField | null {
  const raw = e.dataTransfer.getData(FIELD_DRAG_TYPE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DraggedField;
  } catch {
    return null;
  }
}

/** Label + Fixed/Expression toggle + drop target around a parameter editor. */
export function Field({ label, value, onChange, kind, children, description, hint, required, noExpression, testId, compact, trailing }: FieldProps) {
  const expression = isExpression(value);
  const [over, setOver] = useState(false);
  const canDrop = !noExpression;

  const onDrop = (e: DragEvent) => {
    setOver(false);
    const field = readDropped(e);
    if (!field || !canDrop) return;
    e.preventDefault();
    e.stopPropagation();
    // CodeMirror inserts dropped text itself; only handle drops on fixed inputs.
    if (expression && (e.target as HTMLElement).closest('.cm-editor')) return;
    onChange(withDroppedField(value, field.expression));
  };

  return (
    <div
      data-testid={testId}
      className={cn('group/field flex flex-col gap-1 rounded-md', over && 'ring-2 ring-accent/60 ring-offset-2 ring-offset-panel')}
      onDragOver={(e) => {
        if (canDrop && e.dataTransfer.types.includes(FIELD_DRAG_TYPE)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {!compact && (
        <div className="flex min-h-5 items-center gap-2">
          <label className="text-[12.5px] font-medium text-muted">
            {label}
            {required && <span className="text-danger"> *</span>}
          </label>
          {description && (
            <span title={description} className="text-subtle">
              <Info size={12} />
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {trailing}
            {!noExpression && (
              <div
                className={cn(
                  'flex overflow-hidden rounded border border-line text-[10.5px] transition-opacity',
                  expression ? 'opacity-100' : 'opacity-0 group-hover/field:opacity-100 focus-within:opacity-100',
                )}
              >
                <button
                  type="button"
                  data-testid={testId ? `${testId}-fixed` : undefined}
                  className={cn('px-1.5 py-0.5', !expression ? 'bg-panel-3 text-fg' : 'text-subtle hover:text-fg')}
                  onClick={() => expression && onChange(fromExpression(value as string, kind))}
                >
                  Fixed
                </button>
                <button
                  type="button"
                  data-testid={testId ? `${testId}-expression` : undefined}
                  className={cn('px-1.5 py-0.5', expression ? 'bg-info/20 text-[#9cc8ff]' : 'text-subtle hover:text-fg')}
                  onClick={() => !expression && onChange(toExpression(value))}
                >
                  Expression
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      <div className={cn(compact && !noExpression && 'flex items-start gap-1')}>
        <div className="min-w-0 flex-1">
          {expression && !noExpression ? (
            <ExpressionInput value={value as string} onChange={onChange} testId={testId ? `${testId}-editor` : undefined} />
          ) : (
            children
          )}
        </div>
        {compact && !noExpression && (
          <button
            type="button"
            title={expression ? 'Switch to a fixed value' : 'Use an expression'}
            data-testid={testId ? `${testId}-toggle` : undefined}
            onClick={() => onChange(expression ? fromExpression(value as string, kind) : toExpression(value))}
            className={cn(
              'mt-1 shrink-0 rounded border px-1 py-0.5 font-mono text-[10.5px]',
              expression ? 'border-info/50 bg-info/20 text-[#9cc8ff]' : 'border-line text-subtle hover:text-fg',
            )}
          >
            fx
          </button>
        )}
      </div>
      {hint && <p className="text-[11.5px] text-subtle">{hint}</p>}
    </div>
  );
}

export const inputClass =
  'h-8 w-full min-w-0 rounded-md border border-line-strong bg-panel-2 px-2.5 text-[13px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none';
