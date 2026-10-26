import { Button } from './ui/Button';

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/55" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="w-[420px] max-w-[92vw] animate-fade-in rounded-xl border border-line-strong bg-panel p-5 shadow-2xl" role="dialog" data-testid="confirm-dialog">
        <h2 className="text-[16px] font-semibold">{title}</h2>
        <p className="mt-2 text-[13px] text-muted">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} data-testid="confirm-cancel">
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} data-testid="confirm-ok" autoFocus>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
