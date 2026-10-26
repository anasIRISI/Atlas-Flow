import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import { cn } from './cn';

const STYLES = {
  error: { box: 'border-danger/40 bg-danger/10 text-[#ffb4b2]', Icon: CircleAlert },
  success: { box: 'border-success/40 bg-success/10 text-[#a6efc6]', Icon: CircleCheck },
  info: { box: 'border-info/40 bg-info/10 text-[#b8d8ff]', Icon: Info },
};

export function Alert({ kind = 'error', children }: { kind?: keyof typeof STYLES; children: ReactNode }) {
  const { box, Icon } = STYLES[kind];
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={cn('flex gap-2.5 rounded-md border px-3 py-2.5 text-[13px]', box)}>
      <Icon size={16} className="mt-px shrink-0" />
      <div>{children}</div>
    </div>
  );
}
