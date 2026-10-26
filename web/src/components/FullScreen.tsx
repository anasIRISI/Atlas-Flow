import { RefreshCw, ServerCrash } from 'lucide-react';
import { LogoMark } from './Logo';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';

export function FullScreenLoader() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-4 text-muted">
        <LogoMark size={40} />
        <Spinner />
      </div>
    </div>
  );
}

export function FullScreenError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <ServerCrash size={40} className="text-danger" />
        <h1 className="text-lg font-semibold">Atlas Flow est injoignable</h1>
        <p className="text-muted">{message}</p>
        <p className="text-[13px] text-subtle">
          Vérifie que le serveur est démarré (<code className="font-mono">npm start</code>), puis réessaie.
        </p>
        <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={onRetry}>
          Réessayer
        </Button>
      </div>
    </div>
  );
}
