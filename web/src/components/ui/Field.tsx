import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from './cn';

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: ReactNode;
}

/** Labelled input with error text. Password inputs get a show/hide toggle. */
export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, error, hint, className, type = 'text', id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [reveal, setReveal] = useState(false);
  const isPassword = type === 'password';
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={inputId} className="text-[13px] font-medium text-muted">
        {label}
      </label>
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          type={isPassword && reveal ? 'text' : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
          className={cn(
            'h-10 w-full rounded-md border bg-panel-2 px-3 text-fg placeholder:text-subtle transition-colors',
            'focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/25',
            error ? 'border-danger/70' : 'border-line-strong hover:border-subtle',
            isPassword && 'pr-10',
          )}
          {...rest}
        />
        {isPassword && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setReveal((v) => !v)}
            className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-subtle hover:text-fg"
            aria-label={reveal ? 'Hide password' : 'Show password'}
          >
            {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="text-[12px] text-danger">
          {error}
        </p>
      ) : (
        hint && <div className="text-[12px] text-subtle">{hint}</div>
      )}
    </div>
  );
});
