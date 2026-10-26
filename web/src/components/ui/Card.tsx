import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-line bg-panel', className)} {...rest} />;
}
