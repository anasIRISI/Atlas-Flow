import { cn } from '../components/ui/cn';
import { useWsStore } from '../lib/ws';

const LABELS = {
  idle: { text: 'Hors ligne', dot: 'bg-subtle' },
  connecting: { text: 'Connexion…', dot: 'bg-warning animate-pulse' },
  reconnecting: { text: 'Reconnexion…', dot: 'bg-warning animate-pulse' },
  open: { text: 'En direct', dot: 'bg-success' },
} as const;

export function ConnectionIndicator({ collapsed }: { collapsed?: boolean }) {
  const status = useWsStore((s) => s.status);
  const { text, dot } = LABELS[status];
  return (
    <div
      data-testid="ws-status"
      data-status={status}
      title={`Connexion en direct : ${text}`}
      className={cn('flex items-center gap-2 px-3 py-1.5 text-[12px] text-muted', collapsed && 'justify-center px-0')}
    >
      <span className={cn('size-2 shrink-0 rounded-full', dot)} />
      {!collapsed && <span>{text}</span>}
    </div>
  );
}
