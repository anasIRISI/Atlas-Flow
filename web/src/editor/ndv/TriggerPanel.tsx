import { useEffect, useState } from 'react';
import { ExternalLink, MessagesSquare, Play, QrCode, Radio, Square } from 'lucide-react';
import type { NodeTypeInfo } from '@flowforge/shared';
import { CopyButton } from '../../components/CopyButton';
import { QrDialog, qrSrc } from '../../components/QrDialog';
import { Button } from '../../components/ui/Button';
import { CHAT_TRIGGER, listenForTestEvent, stopListening } from '../actions';
import { editor, useEditor } from '../store';

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return <span className="tabular-nums">{left}s</span>;
}

export function CopyText({ text, testId }: { text: string; testId?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 py-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-[12px]" data-testid={testId} title={text}>
        {text}
      </code>
      <CopyButton text={text} />
    </div>
  );
}

/** Path part of a URL: links opened from the editor stay on the address the editor itself uses. */
export const sameOriginPath = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

/** Listening on a test form: open it here, or scan the QR code with a phone. */
function TestFormLinks({ url }: { url: string }) {
  const [qr, setQr] = useState(false);
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3" data-testid="test-form-links">
      <span className="text-[12.5px] text-muted">Fill in the test form: the workflow runs with your answers.</span>
      <button type="button" onClick={() => setQr(true)} title="Show a large QR code" className="rounded-xl bg-white p-2 shadow-lg transition-transform hover:scale-[1.03]" data-testid="test-form-qr">
        <img src={qrSrc(url, 360)} alt="QR code of the test form" width={150} height={150} className="block size-[150px]" />
      </button>
      <div className="w-full text-left">
        <CopyText text={url} testId="test-url" />
      </div>
      <div className="flex gap-2">
        <a
          href={sameOriginPath(url)}
          target="_blank"
          rel="noreferrer"
          data-testid="open-test-form"
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-white hover:bg-accent-hover"
        >
          <ExternalLink size={14} /> Open test form
        </a>
        <Button size="sm" variant="secondary" icon={<QrCode size={14} />} onClick={() => setQr(true)}>
          QR code
        </Button>
      </div>
      {qr && <QrDialog url={url} title="Test form" openHref={sameOriginPath(url)} fileName="test-form-qr" note="The test URL works for one submission while the editor is listening." onClose={() => setQr(false)} />}
    </div>
  );
}

/** Shown in the OUTPUT panel of trigger nodes that have no data yet. */
export function TriggerPanel({ nodeName, type }: { nodeName: string; type: NodeTypeInfo }) {
  const listening = useEditor((s) => (s.listening?.nodeName === nodeName ? s.listening : null));
  const kind = type.trigger?.kind ?? 'manual';

  if (listening) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="trigger-listening">
        <Radio size={28} className="animate-pulse text-accent-hover" />
        <div className="text-[14px] font-medium">Listening for a test event…</div>
        {listening.testUrl && /\/form-test\//.test(listening.testUrl) ? (
          <TestFormLinks url={listening.testUrl} />
        ) : listening.testUrl ? (
          <div className="flex w-full max-w-md flex-col gap-1.5 text-left">
            <span className="text-[12px] text-subtle">Call this URL ({listening.method}) — it works once:</span>
            <CopyText text={listening.testUrl} testId="test-url" />
            <code className="rounded bg-panel-2 px-2 py-1 font-mono text-[11.5px] text-muted">
              curl -X {listening.method?.split(',')[0] ?? 'GET'} {listening.testUrl}
            </code>
          </div>
        ) : (
          <div className="text-[12.5px] text-muted">Waiting for the next event of "{nodeName}".</div>
        )}
        {listening.expiresAt && (
          <div className="text-[12px] text-subtle">
            Stops in <Countdown until={listening.expiresAt} />
          </div>
        )}
        <Button size="sm" variant="secondary" icon={<Square size={13} />} onClick={() => void stopListening()} data-testid="stop-listening">
          Stop listening
        </Button>
      </div>
    );
  }

  if (type.type === CHAT_TRIGGER) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-[12.5px] text-subtle">
        Send a message in the test chat: the workflow runs with it and the reply of the last node appears in the chat.
        <Button
          size="sm"
          icon={<MessagesSquare size={14} />}
          data-testid="open-chat"
          onClick={() => {
            editor.setUi({ chatOpen: true });
            editor.openPanel(null);
          }}
        >
          Open chat
        </Button>
      </div>
    );
  }

  const listens = kind === 'webhook' || kind === 'listener';
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-[12.5px] text-subtle">
      {listens
        ? type.type === 'flowforge.formTrigger'
          ? 'Start listening, then open the test form (a QR code for your phone appears here) and submit it.'
          : 'Start listening, then trigger the event (call the URL, add a file…). The workflow runs once with that data.'
        : kind === 'poll'
          ? 'Fetch the newest item now to see what this trigger outputs.'
          : 'Run this trigger now to see what it outputs.'}
      <Button size="sm" icon={listens ? <Radio size={14} /> : <Play size={14} />} onClick={() => void listenForTestEvent(nodeName)} data-testid="listen-test-event">
        {listens ? 'Listen for test event' : 'Fetch test event'}
      </Button>
    </div>
  );
}
