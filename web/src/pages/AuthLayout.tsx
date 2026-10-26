import type { ReactNode } from 'react';
import { Logo } from '../components/Logo';

/** Centered card used by the sign-in and owner-setup screens. */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <div className="relative grid min-h-full place-items-center overflow-hidden p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            'radial-gradient(circle at 20% 15%, rgb(56 189 248 / 0.16), transparent 40%), radial-gradient(circle at 85% 85%, rgb(45 212 191 / 0.12), transparent 40%), radial-gradient(rgb(255 255 255 / 0.05) 1px, transparent 1px)',
          backgroundSize: 'auto, auto, 22px 22px',
        }}
      />
      <div className="relative w-full max-w-[420px] animate-fade-in">
        <Logo className="mb-8 justify-center" />
        <div className="rounded-xl border border-line bg-panel/95 p-7 shadow-2xl shadow-black/40 backdrop-blur">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
