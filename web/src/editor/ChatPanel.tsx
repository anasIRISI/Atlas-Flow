import { useEffect, useRef, useState } from 'react';
import { MessagesSquare, RotateCcw, SendHorizontal, X } from 'lucide-react';
import { cn } from '../components/ui/cn';
import { chatTriggerName, sendChatMessage } from './actions';
import { editor, useEditor } from './store';

interface ChatLine {
  role: 'user' | 'bot' | 'error';
  text: string;
}

/** Same light formatting as the hosted chat page: **bold**, `code` and links (as React nodes, never raw HTML). */
function rich(text: string) {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g).map((part, i) => {
    if (/^\*\*.+\*\*$/.test(part)) return <b key={i}>{part.slice(2, -2)}</b>;
    if (/^`.+`$/.test(part)) return <code key={i} className="rounded bg-black/30 px-1 font-mono text-[12px]">{part.slice(1, -1)}</code>;
    if (/^https?:\/\//.test(part)) return <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline">{part}</a>;
    return part;
  });
}

const newSession = () => `editor-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/** Test chat of a Chat Trigger: every message runs the workflow (visible live on the canvas) and shows the reply. */
export function ChatPanel() {
  const open = useEditor((s) => s.chatOpen);
  const trigger = useEditor((s) => chatTriggerName(s.nodes));
  const workflowId = useEditor((s) => s.workflowId);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState(newSession);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setLines([]);
    setSession(newSession());
  }, [workflowId]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [lines, busy]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  if (!trigger) return null;
  if (!open) {
    return (
      <button
        type="button"
        data-testid="chat-open"
        onClick={() => editor.setUi({ chatOpen: true })}
        className="absolute bottom-4 right-4 z-10 inline-flex h-10 items-center gap-2 rounded-full bg-accent px-4 text-[13px] font-medium text-white shadow-lg hover:bg-accent-hover"
      >
        <MessagesSquare size={16} /> Chat
      </button>
    );
  }

  const send = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setText('');
    setLines((l) => [...l, { role: 'user', text: message }]);
    setBusy(true);
    try {
      const reply = await sendChatMessage(trigger, session, message);
      setLines((l) => [...l, { role: 'bot', text: reply }]);
    } catch (err) {
      setLines((l) => [...l, { role: 'error', text: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  return (
    <div className="absolute bottom-4 right-4 z-10 flex h-[min(520px,calc(100%-2rem))] w-[min(380px,calc(100%-2rem))] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" data-testid="chat-panel">
      <div className="flex items-center gap-2 border-b border-line bg-panel-2 px-3 py-2">
        <MessagesSquare size={15} className="text-accent-hover" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">Test chat</div>
          <div className="truncate text-[11px] text-subtle">Each message runs the workflow from "{trigger}"</div>
        </div>
        <button
          type="button"
          title="New session (forgets the conversation)"
          data-testid="chat-reset"
          onClick={() => {
            setLines([]);
            setSession(newSession());
          }}
          className="rounded p-1.5 text-subtle hover:bg-panel-3 hover:text-fg"
        >
          <RotateCcw size={14} />
        </button>
        <button type="button" title="Close" data-testid="chat-close" onClick={() => editor.setUi({ chatOpen: false })} className="rounded p-1.5 text-subtle hover:bg-panel-3 hover:text-fg">
          <X size={15} />
        </button>
      </div>
      <div ref={log} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3" data-testid="chat-log">
        {lines.length === 0 && <p className="m-auto max-w-[240px] text-center text-[12.5px] text-subtle">Send a message to run the workflow. The reply is the output of its last node.</p>}
        {lines.map((line, i) => (
          <div
            key={i}
            data-testid={`chat-message-${line.role}`}
            className={cn(
              'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[13px]',
              line.role === 'user' && 'self-end rounded-br-sm bg-accent text-white',
              line.role === 'bot' && 'self-start rounded-bl-sm bg-panel-3',
              line.role === 'error' && 'self-start border border-danger/40 bg-danger/10 text-danger',
            )}
          >
            {line.role === 'bot' ? rich(line.text) : line.text}
          </div>
        ))}
        {busy && (
          <div className="self-start rounded-2xl rounded-bl-sm bg-panel-3 px-3 py-2 text-[13px] text-subtle" data-testid="chat-typing">
            <span className="animate-pulse">Running the workflow…</span>
          </div>
        )}
      </div>
      <form
        className="flex items-end gap-2 border-t border-line p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={input}
          rows={1}
          value={text}
          data-testid="chat-input"
          placeholder="Type a message…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
            e.stopPropagation();
          }}
          className="max-h-28 min-h-9 flex-1 resize-none rounded-lg border border-line bg-panel-2 px-2.5 py-2 text-[13px] outline-none focus:border-accent"
        />
        <button type="submit" disabled={busy || !text.trim()} data-testid="chat-send" title="Send" className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-white hover:bg-accent-hover disabled:opacity-40">
          <SendHorizontal size={16} />
        </button>
      </form>
    </div>
  );
}
