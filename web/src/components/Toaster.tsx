import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { cn } from './ui/cn';
import { useToasts } from '../lib/toast';

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[360px] max-w-[92vw] flex-col gap-2">
      {toasts.map((t) => {
        const Icon = t.kind === 'success' ? CircleCheck : t.kind === 'error' ? CircleAlert : Info;
        return (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            data-testid={`toast-${t.kind}`}
            className={cn(
              'pointer-events-auto flex animate-fade-in gap-2.5 rounded-lg border bg-panel px-3.5 py-3 shadow-xl shadow-black/40',
              t.kind === 'success' ? 'border-success/40' : t.kind === 'error' ? 'border-danger/50' : 'border-line-strong',
            )}
          >
            <Icon size={17} className={cn('mt-0.5 shrink-0', t.kind === 'success' ? 'text-success' : t.kind === 'error' ? 'text-danger' : 'text-info')} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{t.title}</div>
              {t.message && <div className="mt-0.5 break-words text-[12.5px] text-muted">{t.message}</div>}
            </div>
            <button type="button" onClick={() => useToasts.getState().dismiss(t.id)} className="h-fit rounded p-0.5 text-subtle hover:text-fg" aria-label="Dismiss">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
