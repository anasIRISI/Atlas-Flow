import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** Copies text; falls back to a hidden textarea on http:// LAN addresses where the Clipboard API is blocked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export function CopyButton({ text, testId, size = 13 }: { text: string; testId?: string; size?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy"
      data-testid={testId}
      data-copied={copied}
      onClick={() =>
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
      className="shrink-0 rounded p-1 text-subtle hover:bg-panel-3 hover:text-fg"
    >
      {copied ? <Check size={size} className="text-success" /> : <Copy size={size} />}
    </button>
  );
}
