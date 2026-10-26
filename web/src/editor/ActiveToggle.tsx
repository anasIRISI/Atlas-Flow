import { useState } from 'react';
import { cn } from '../components/ui/cn';
import { setActive } from './actions';
import { useEditor } from './store';

/** Active switch + status dot (green = active, red = a trigger failed, grey = inactive). */
export function ActiveToggle() {
  const active = useEditor((s) => s.active);
  const activationError = useEditor((s) => s.activationError);
  const triggerError = useEditor((s) => s.triggerError);
  const [busy, setBusy] = useState(false);
  const problem = active ? triggerError : activationError;
  const label = active ? (triggerError ? 'Active · trigger error' : 'Active') : 'Inactive';
  return (
    <div className="flex items-center gap-2" title={problem ?? (active ? 'Triggers are live' : 'Triggers are off')}>
      <span
        data-testid="active-status"
        data-state={active ? (triggerError ? 'error' : 'active') : activationError ? 'failed' : 'inactive'}
        className={cn('flex items-center gap-1.5 text-[12px]', active ? (triggerError ? 'text-danger' : 'text-success') : activationError ? 'text-danger' : 'text-subtle')}
      >
        <span className={cn('size-2 rounded-full', active ? (triggerError ? 'bg-danger' : 'bg-success') : activationError ? 'bg-danger' : 'bg-line-strong')} />
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={active}
        aria-label={active ? 'Deactivate workflow' : 'Activate workflow'}
        data-testid="active-toggle"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await setActive(!active);
          setBusy(false);
        }}
        className={cn('relative h-5 w-9 rounded-full transition-colors disabled:opacity-50', active ? 'bg-success' : 'bg-line-strong')}
      >
        <span className={cn('absolute top-0.5 size-4 rounded-full bg-white transition-all', active ? 'left-[18px]' : 'left-0.5')} />
      </button>
    </div>
  );
}
