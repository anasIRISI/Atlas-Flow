import { cn } from './cn';

export function Toggle({ checked, onChange, testId, label }: { checked: boolean; onChange(v: boolean): void; testId?: string; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={cn('relative h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-strong')}
    >
      <span className={cn('absolute top-0.5 size-4 rounded-full bg-white transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
    </button>
  );
}
