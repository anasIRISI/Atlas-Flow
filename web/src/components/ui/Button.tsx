import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { Spinner } from './Spinner';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover shadow-sm shadow-accent/20',
  secondary: 'bg-panel-3 text-fg border border-line-strong hover:bg-line-strong/60',
  ghost: 'text-muted hover:text-fg hover:bg-panel-3',
  danger: 'bg-danger/90 text-white hover:bg-danger',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-5 text-[15px] gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium transition-colors select-none',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
    >
      {loading ? <Spinner size={16} /> : icon}
      {children}
    </button>
  );
}
