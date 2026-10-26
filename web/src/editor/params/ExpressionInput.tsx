import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { cn } from '../../components/ui/cn';
import { useEditor, workflowData } from '../store';
import { CodeMirror } from './CodeMirror';
import { expressionExtensions } from './cm';
import { useNodeEdit } from './context';

interface PreviewResult {
  ok: boolean;
  value?: unknown;
  type?: string;
  error?: { message: string; hint?: string };
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '[empty]';
  if (typeof value === 'string') return value === '' ? '[empty string]' : value;
  return JSON.stringify(value, null, 1);
}

/** Live result of an expression for the first input item, computed by the server. */
function usePreview(expression: string): PreviewResult | null {
  const { nodeName, inputItems, source } = useNodeEdit();
  const runData = useEditor((s) => s.runData);
  const [result, setResult] = useState<PreviewResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      api<PreviewResult>('/expressions/preview', {
        method: 'POST',
        body: { expression, inputItems: inputItems.slice(0, 1), workflow: workflowData(), runData: runData ?? {}, nodeName, source },
      })
        .then((r) => !cancelled && setResult(r))
        .catch((err: Error) => !cancelled && setResult({ ok: false, error: { message: err.message } }));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [expression, inputItems, runData, nodeName, source]);
  return result;
}

/** Expression editor (value starts with "=") with {{ }} highlighting, autocomplete and a live preview. */
export function ExpressionInput({ value, onChange, testId }: { value: string; onChange(v: string): void; testId?: string }) {
  const { completion } = useNodeEdit();
  const completionRef = useRef(completion);
  completionRef.current = completion;
  const extensions = useMemo(() => expressionExtensions(() => completionRef.current, 'Type {{ to insert data, e.g. {{ $json.name }}'), []);
  const preview = usePreview(value);
  return (
    <div className="flex flex-col gap-1">
      <CodeMirror value={value.slice(1)} onChange={(v) => onChange(`=${v}`)} extensions={extensions} testId={testId} className="border-info/40" />
      <div
        data-testid={testId ? `${testId}-preview` : undefined}
        className={cn(
          'max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md px-2 py-1 font-mono text-[11.5px]',
          !preview ? 'text-subtle' : preview.ok ? 'bg-success/8 text-[#9fe5bd]' : 'bg-danger/10 text-[#ffb4b2]',
        )}
      >
        {!preview ? '…' : preview.ok ? formatValue(preview.value) : `${preview.error?.message ?? 'Error'}${preview.error?.hint ? ` — ${preview.error.hint}` : ''}`}
      </div>
    </div>
  );
}
