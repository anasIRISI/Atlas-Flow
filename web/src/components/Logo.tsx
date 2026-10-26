import { cn } from './ui/cn';

export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="ff-logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3298d8" />
          <stop offset="1" stopColor="#0d9488" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#ff-logo-g)" />
      <g fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="10" r="2.6" />
        <circle cx="9" cy="22" r="2.6" />
        <circle cx="23" cy="16" r="2.6" />
        <path d="M11.6 10h3.4a3 3 0 0 1 3 3v0.4a2.6 2.6 0 0 0 2.4 2.6M11.6 22h3.4a3 3 0 0 0 3-3v-0.4a2.6 2.6 0 0 1 2.4-2.6" />
      </g>
    </svg>
  );
}

export function Logo({ collapsed, className }: { collapsed?: boolean; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <LogoMark />
      {!collapsed && <span className="text-[17px] font-semibold tracking-tight">Atlas <span className="text-teal-300">Flow</span></span>}
    </div>
  );
}
