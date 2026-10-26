import { useMemo, useState } from 'react';
import { Monitor, Smartphone } from 'lucide-react';
import { isFormTheme, normalizeFormFields, renderFormPage, type WorkflowNode } from '@flowforge/shared';
import { cn } from '../../components/ui/cn';

const text = (v: unknown, fallback = '') => {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
  // Expressions are resolved when the form is opened; the preview shows them as written.
  return (s.startsWith('=') ? s.slice(1) : s) || fallback;
};

/** HTML of the form exactly as the server renders it (same shared renderer). */
export function previewHtml(parameters: WorkflowNode['parameters'], defaults: Record<string, unknown> = {}): string {
  const p = { ...defaults, ...parameters } as Record<string, unknown>;
  const options = (p.options ?? {}) as Record<string, unknown>;
  return renderFormPage({
    title: text(p.formTitle, 'Form'),
    description: text(p.formDescription),
    fields: normalizeFormFields(p.formFields),
    theme: isFormTheme(p.formTheme) ? p.formTheme : 'midnight',
    buttonLabel: text(options.buttonLabel ?? p.formButtonLabel, 'Submit'),
    attribution: options.appendAttribution !== false,
    action: '#',
    mode: 'preview',
  });
}

/** Live preview next to the form builder: phone or desktop frame, updated on every change. */
export function FormPreview({ parameters, defaults }: { parameters: WorkflowNode['parameters']; defaults: Record<string, unknown> }) {
  const [device, setDevice] = useState<'phone' | 'desktop'>('phone');
  const html = useMemo(() => previewHtml(parameters, defaults), [parameters, defaults]);
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="form-preview">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-subtle">Live preview</span>
        <div className="ml-auto flex overflow-hidden rounded border border-line">
          {(
            [
              ['phone', Smartphone],
              ['desktop', Monitor],
            ] as const
          ).map(([d, Icon]) => (
            <button
              key={d}
              type="button"
              title={d === 'phone' ? 'Phone' : 'Desktop'}
              data-testid={`form-preview-${d}`}
              onClick={() => setDevice(d)}
              className={cn('px-2 py-1', device === d ? 'bg-panel-3 text-fg' : 'text-subtle hover:text-fg')}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-stretch justify-center overflow-hidden bg-[#0b0b0e] p-4">
        <div className={cn('h-full overflow-hidden bg-black shadow-2xl transition-all', device === 'phone' ? 'w-[375px] max-w-full rounded-[30px] border-[7px] border-[#2a2a33]' : 'w-full rounded-lg border border-line-strong')}>
          {/* sandbox without allow-same-origin: the preview cannot touch the editor or submit anything. */}
          <iframe title="Form preview" data-testid="form-preview-frame" sandbox="allow-scripts" srcDoc={html} className="size-full border-0 bg-white" />
        </div>
      </div>
    </section>
  );
}
