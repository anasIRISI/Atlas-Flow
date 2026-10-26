import { useState } from 'react';
import { Pin, PinOff, Play } from 'lucide-react';
import type { ConnectionSpec, Item, NodeRun } from '@flowforge/shared';
import { Button } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';
import { plural } from '../../lib/format';
import { DataView, hasBinary, savedView, ViewSwitch, type ViewMode } from './DataView';
import { ErrorCard } from './ErrorCard';

function Header({ title, count, children }: { title: string; count?: number; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-subtle">{title}</span>
      {count !== undefined && (
        <span className="rounded-full bg-panel-3 px-2 py-0.5 text-[11px] text-muted" data-testid={`${title.toLowerCase()}-count`}>
          {plural(count, 'item')}
        </span>
      )}
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Empty({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-[12.5px] text-subtle">
      {text}
      {action}
    </div>
  );
}

interface InputPanelProps {
  items: Item[];
  fromNode?: string;
  inputLabels: string[];
  inputIndex: number;
  onInputIndex(i: number): void;
}

export function InputPanel({ items, fromNode, inputLabels, inputIndex, onInputIndex }: InputPanelProps) {
  const [view, setView] = useState<ViewMode>(savedView);
  return (
    <section className="flex min-h-0 flex-col" data-testid="input-panel">
      <Header title="Input" count={fromNode ? items.length : undefined}>
        {inputLabels.length > 1 && (
          <select className="rounded border border-line bg-panel-2 px-1.5 py-0.5 text-[12px]" value={inputIndex} onChange={(e) => onInputIndex(Number(e.target.value))}>
            {inputLabels.map((l, i) => (
              <option key={i} value={i}>
                {l}
              </option>
            ))}
          </select>
        )}
        {fromNode && <span className="max-w-40 truncate text-[12px] text-muted">from {fromNode}</span>}
        <ViewSwitch view={view} onChange={setView} binary={hasBinary(items)} />
      </Header>
      {!fromNode ? (
        <Empty text="Nothing is connected to this input yet." />
      ) : items.length === 0 ? (
        <Empty text={`No input data yet. Execute the previous nodes to see what "${fromNode}" outputs.`} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <DataView items={items} view={view} draggable />
        </div>
      )}
    </section>
  );
}

interface OutputPanelProps {
  /** Replaces the "Execute this node" empty state (trigger nodes: listen for a test event). */
  emptyState?: React.ReactNode;
  runs: NodeRun[];
  outputs: ConnectionSpec[];
  pinned?: Item[];
  canPin: boolean;
  running: boolean;
  onExecute(): void;
  onPin(items: Item[]): void;
  onUnpin(): void;
}

export function OutputPanel({ emptyState, runs, outputs, pinned, canPin, running, onExecute, onPin, onUnpin }: OutputPanelProps) {
  const [view, setView] = useState<ViewMode>(savedView);
  const [runIndex, setRunIndex] = useState<number | null>(null);
  const [outputIndex, setOutputIndex] = useState(0);
  const run = runs[runIndex ?? runs.length - 1];
  // Pinned data wins: it is what the next manual run will use.
  const showPinned = Boolean(pinned);
  const lists = showPinned ? [pinned!] : (run?.data.main ?? []);
  const current = Math.min(outputIndex, Math.max(0, lists.length - 1));
  const items = lists[current] ?? [];

  return (
    <section className="flex min-h-0 flex-col" data-testid="output-panel">
      <Header title="Output" count={run || showPinned ? items.length : undefined}>
        {runs.length > 1 && (
          <select
            data-testid="run-selector"
            className="rounded border border-line bg-panel-2 px-1.5 py-0.5 text-[12px]"
            value={runIndex ?? runs.length - 1}
            onChange={(e) => setRunIndex(Number(e.target.value))}
          >
            {runs.map((_, i) => (
              <option key={i} value={i}>
                Run {i + 1} of {runs.length}
              </option>
            ))}
          </select>
        )}
        {canPin &&
          (pinned ? (
            <button type="button" data-testid="unpin-data" onClick={onUnpin} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-[#c4a6ff] hover:bg-panel-3">
              <PinOff size={13} /> Unpin
            </button>
          ) : (
            items.length > 0 && (
              <button type="button" data-testid="pin-data" onClick={() => onPin(items)} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px] text-muted hover:bg-panel-3 hover:text-fg">
                <Pin size={13} /> Pin
              </button>
            )
          ))}
        <ViewSwitch view={view} onChange={setView} binary={hasBinary(items)} />
      </Header>
      {showPinned && (
        <div className="border-b border-line bg-[#7c4dff]/10 px-3 py-1.5 text-[12px] text-[#c4a6ff]" data-testid="pinned-banner">
          This data is pinned: manual runs use it instead of executing the node.
        </div>
      )}
      {lists.length > 1 && (
        <div className="flex gap-1 border-b border-line px-2 py-1.5">
          {lists.map((list, i) => (
            <button
              key={i}
              type="button"
              data-testid={`output-tab-${i}`}
              onClick={() => setOutputIndex(i)}
              className={cn('rounded px-2 py-0.5 text-[12px]', current === i ? 'bg-panel-3 text-fg' : 'text-subtle hover:text-fg')}
            >
              {outputs[i]?.displayName ?? `Output ${i}`} <span className="text-subtle">({list.length})</span>
            </button>
          ))}
        </div>
      )}
      {run?.error && !showPinned && <ErrorCard error={run.error} />}
      {!run && !showPinned && emptyState ? (
        emptyState
      ) : !run && !showPinned ? (
        <Empty
          text="Execute this node to see its output."
          action={
            <Button size="sm" icon={<Play size={14} />} loading={running} onClick={onExecute} data-testid="output-execute">
              Execute step
            </Button>
          }
        />
      ) : items.length === 0 && !run?.error ? (
        <Empty text={run?.status === 'disabled' ? 'The node is disabled: its input was passed through.' : 'No output items on this branch.'} />
      ) : (
        items.length > 0 && (
          <div className="min-h-0 flex-1 overflow-auto">
            <DataView items={items} view={view} draggable={false} />
          </div>
        )
      )}
      {run?.logs && run.logs.length > 0 && (
        <details className="border-t border-line px-3 py-2 text-[12px]">
          <summary className="cursor-pointer text-muted">console.log output ({run.logs.length})</summary>
          <pre className="mt-1 max-h-40 overflow-auto font-mono text-[11.5px] text-fg">{run.logs.join('\n')}</pre>
        </details>
      )}
    </section>
  );
}
