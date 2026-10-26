import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, CircleCheck, Copy, Cpu, Globe, HardDrive, Radio } from 'lucide-react';
import type { HealthResponse, SystemInfo } from '@flowforge/shared';
import { Card } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { Spinner } from '../../components/ui/Spinner';
import { api } from '../../lib/api';
import { useWsStore } from '../../lib/ws';

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${seconds % 60}s` : `${seconds}s`;
}

function StatCard({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-2 text-[12px] font-medium uppercase tracking-wide text-subtle">
        {icon}
        {label}
      </div>
      <div className="min-h-[44px]">{children}</div>
    </Card>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="rounded p-1 text-subtle hover:bg-panel-3 hover:text-fg"
      aria-label="Copy"
      title="Copy"
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </button>
  );
}

/** Server, real-time, public URL and data folder (the former Overview cards; test ids are used by the e2e suite). */
export function SystemCards() {
  const wsStatus = useWsStore((s) => s.status);
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<HealthResponse>('/health'), refetchInterval: 30_000 });
  const info = useQuery({ queryKey: ['system', 'info'], queryFn: () => api<SystemInfo>('/system/info') });

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard icon={<Cpu size={14} />} label="Serveur">
        {health.data ? (
          <div data-testid="server-status">
            <div className="flex items-center gap-2 font-medium text-success">
              <CircleCheck size={16} /> En marche
            </div>
            <div className="mt-1 text-[12px] text-muted">
              v{health.data.version} · Node {health.data.nodeVersion} · up {formatUptime(health.data.uptimeSeconds)}
            </div>
          </div>
        ) : health.isError ? (
          <span className="text-danger">Injoignable</span>
        ) : (
          <Spinner />
        )}
      </StatCard>

      <StatCard icon={<Radio size={14} />} label="Temps réel">
        <div className={cn('font-medium', wsStatus === 'open' ? 'text-success' : 'text-warning')}>
          {wsStatus === 'open' ? 'Connecté' : wsStatus === 'idle' ? 'Hors ligne' : 'Connexion…'}
        </div>
        <div className="mt-1 text-[12px] text-muted">Suivi des exécutions en direct</div>
      </StatCard>

      <StatCard icon={<Globe size={14} />} label="URL publique">
        {info.data ? (
          <>
            <div className="flex items-center gap-1">
              <span className="truncate font-mono text-[13px]" data-testid="public-url">
                {info.data.publicUrl}
              </span>
              <CopyButton text={info.data.publicUrl} />
            </div>
            <div className="mt-1 text-[12px] text-muted">Webhooks, formulaires et QR codes</div>
          </>
        ) : (
          <Spinner />
        )}
      </StatCard>

      <StatCard icon={<HardDrive size={14} />} label="Données locales">
        {info.data ? (
          <>
            <div className="truncate font-mono text-[13px]" style={{ direction: 'rtl', textAlign: 'left' }} title={info.data.dataDir}>
              <bdi>{info.data.dataDir}</bdi>
            </div>
            <div className="mt-1 text-[12px] text-muted">Base SQLite, fichiers et clés</div>
          </>
        ) : (
          <Spinner />
        )}
      </StatCard>
    </div>
  );
}
