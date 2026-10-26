import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { Check, CircleAlert, Hourglass, LoaderCircle, Pin, Plus, PowerOff, Radio, TriangleAlert } from 'lucide-react';
import type { Item } from '@flowforge/shared';
import { cn } from '../../components/ui/cn';
import { aiOutput, aiSlots, iconFor, isTriggerType, resolveSubtitle, SLOT_LABELS, staticOutputs } from '../../lib/node-types';
import { plural } from '../../lib/format';
import { CLUSTER_WIDTH, listAllEdges, listEdges, SUB_SIZE } from '../graph';
import { editor, useEditor } from '../store';
import { PreviewBubble } from './PreviewBubble';
import { useNodeTypeMap } from './types-context';

const handleTop = (i: number, n: number) => `${((i + 1) / (n + 1)) * 100}%`;

/** A workflow node on the canvas: icon box, name, subtitle, status, handles. */
export const WorkflowNodeCard = memo(function WorkflowNodeCard({ id, selected }: NodeProps) {
  const node = useEditor((s) => s.nodes.find((n) => n.id === id));
  const live = useEditor((s) => (node ? s.execution.nodes[node.name] : undefined));
  const pinned = useEditor((s) => (node ? Boolean(s.pinData[node.name]) : false));
  const listening = useEditor((s) => (node ? s.listening?.nodeName === node.name : false));
  const dynamic = useEditor((s) => s.dynamicOutputs[id]);
  const connections = useEditor((s) => s.connections);
  const types = useNodeTypeMap();
  const type = node ? types.get(node.type) : undefined;
  const updateInternals = useUpdateNodeInternals();
  const handleKey = node ? `${(type?.inputs ?? []).length}:${(dynamic ?? staticOutputs(type, node)).length}:${aiOutput(type) ?? ''}` : '';
  const missing = useEditor((s) => (node ? s.missingCredentials[node.name] : undefined));
  const fresh = useEditor((s) => (node ? s.fresh.includes(node.name) : false));
  // Demo Mode only: the last run of this node returned simulated output (no credential).
  const simulated = useEditor((s) => (node ? s.runData?.[node.name]?.at(-1)?.simulated === true : false));
  // Switch/Filter outputs arrive from the server after the first render: re-measure the handles,
  // otherwise React Flow cannot draw the connections attached to the new handles.
  useEffect(() => {
    updateInternals(id);
  }, [handleKey, id, updateInternals]);
  const connectedOutputs = useMemo(
    () => new Set(node ? listEdges(connections).filter((e) => e.source === node.name).map((e) => e.output) : []),
    [connections, node],
  );
  // How many sub-nodes are plugged into each AI slot of this node.
  const slotCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (node) for (const e of listAllEdges(connections)) if (e.target === node.name && e.type && e.type !== 'main') counts[e.type] = (counts[e.type] ?? 0) + 1;
    return counts;
  }, [connections, node]);
  // Hover preview of the last run: read on demand (no store subscription), bubble mounted only while hovering.
  const [hover, setHover] = useState<Item[] | null>(null);
  const name = node?.name;
  const onEnter = useCallback(() => {
    const s = useEditor.getState();
    const status = name ? s.execution.nodes[name]?.status : undefined;
    if (!name || !status || status === 'running') return;
    const run = s.runData?.[name]?.at(-1);
    const main = run?.data?.main ?? [];
    setHover(main.find((l) => l && l.length) ?? main[0] ?? []);
  }, [name]);
  const onLeave = useCallback(() => setHover(null), []);
  if (!node) return null;

  const slots = aiSlots(type);
  const subType = aiOutput(type);
  const width = slots.length ? CLUSTER_WIDTH : subType ? SUB_SIZE : 100;
  const height = subType ? SUB_SIZE : 100;
  const Icon = iconFor(type?.icon);
  const trigger = isTriggerType(type);
  const inputs = (type?.inputs ?? []).filter((i) => i.type === 'main');
  const outputs = dynamic ?? staticOutputs(type, node);
  const subtitle = resolveSubtitle(type, node);
  const status = live?.status;
  const ok = status === 'success' || status === 'reused' || status === 'pinned';

  return (
    <div
      className={cn('group/node relative flex flex-col items-center', fresh && 'ff-node-pop')}
      style={{ width }}
      data-testid="canvas-node"
      data-node-name={node.name}
      data-status={status ?? 'idle'}
      data-disabled={node.disabled ? 'true' : undefined}
      data-sub-node={subType ?? undefined}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      title={live?.error && !hover ? `${live.error.message}${live.error.hint ? `\n\n${live.error.hint}` : ''}` : undefined}
    >
      <div
        className={cn(
          'relative flex items-center justify-center border-2 bg-panel-2 transition-[box-shadow,border-color] duration-200',
          subType ? 'rounded-full' : trigger ? 'rounded-l-[42px] rounded-r-xl' : 'rounded-xl',
          selected ? 'border-accent shadow-[0_0_0_4px_rgba(240,89,42,0.18)]' : 'border-line-strong',
          status === 'running' && 'ff-node-running border-info',
          status === 'error' && 'ff-shake',
          ok && !selected && 'border-success/80',
          status === 'error' && !selected && 'border-danger',
          status === 'waiting' && !selected && 'border-warning',
          listening && 'ff-node-listening',
          node.disabled && 'opacity-50',
        )}
        style={{ width, height }}
      >
        <Icon size={subType ? 30 : 38} strokeWidth={1.6} style={{ color: node.disabled ? 'var(--color-subtle)' : (type?.defaults.color ?? 'var(--color-fg)') }} />
        {/* A cluster node is wide: its name sits inside the box, the slots and their sub-nodes below it. */}
        {slots.length > 0 && <span className={cn('ml-3 line-clamp-2 max-w-[150px] text-[13px] font-medium leading-tight', node.disabled && 'text-subtle line-through')}>{node.name}</span>}
        {node.disabled && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="h-[2px] w-[120%] rotate-45 bg-subtle/70" />
          </span>
        )}
        {pinned && (
          <span className="absolute right-1.5 top-1.5 text-[#c4a6ff]" data-testid="node-pinned" title="Pinned data">
            <Pin size={14} />
          </span>
        )}
        {node.disabled && (
          <span className="absolute left-1.5 top-1.5 text-subtle" title="Disabled">
            <PowerOff size={13} />
          </span>
        )}
        {status === 'running' && <LoaderCircle size={16} className="absolute bottom-1.5 right-1.5 animate-spin text-info" />}
        {ok && <Check size={18} strokeWidth={3} className="ff-check-pop absolute bottom-1.5 right-1.5 text-success" data-testid="node-success" />}
        {status === 'error' && <CircleAlert size={18} className="absolute bottom-1.5 right-1.5 text-danger" data-testid="node-error-badge" />}
        {status === 'waiting' && <Hourglass size={16} className="absolute bottom-1.5 right-1.5 text-warning" data-testid="node-waiting" />}
        {hover && !live?.error && <PreviewBubble items={hover} title={node.name} className="bottom-full left-1/2 mb-2 -translate-x-1/2" />}
        {listening && <Radio size={15} className="absolute bottom-1.5 left-1.5 animate-pulse text-accent-hover" data-testid="node-listening" />}
        {simulated && (
          <span
            className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded bg-[#f97316] px-1.5 py-px text-[9px] font-bold tracking-wide text-black shadow"
            data-testid="node-simulated"
            title="Demo Mode: this node has no credential, so its output is made up (_simulated: true)."
          >
            SIMULATED
          </span>
        )}
        {missing?.length && !node.disabled ? (
          <span
            className={cn('absolute text-warning', subType ? '-left-1 -top-1' : 'left-1.5 top-1.5')}
            data-testid="node-missing-credential"
            title={`Credential to add: ${missing.join(', ')}. Open the node to create it.`}
          >
            <TriangleAlert size={16} fill="var(--color-panel)" />
          </span>
        ) : null}

        {subType && (
          <Handle
            id={`sub-${subType}`}
            type="source"
            position={Position.Top}
            className="!size-3 !rotate-45 !rounded-[2px] !border-2 !border-panel !bg-[#8b7fd1] hover:!bg-accent"
          />
        )}
        {slots.map((slot, i) => {
          const count = slotCounts[slot.type] ?? 0;
          const full = slot.maxConnections !== undefined && count >= slot.maxConnections;
          return (
            <Handle
              key={`slot-${slot.type}`}
              id={`slot-${slot.type}`}
              type="target"
              position={Position.Bottom}
              style={{ left: `${((i + 0.5) / slots.length) * 100}%` }}
              className="!size-3 !rotate-45 !rounded-[2px] !border-2 !border-panel !bg-[#8b7fd1] hover:!bg-accent"
            >
              <span className="pointer-events-none absolute left-1/2 top-3.5 -translate-x-1/2 -rotate-45 whitespace-nowrap text-[10px] text-subtle">
                {slot.displayName ?? SLOT_LABELS[slot.type] ?? slot.type}
                {slot.required && <span className={count ? 'text-subtle' : 'text-danger'}> *</span>}
              </span>
              {!full && (
                <button
                  type="button"
                  title={`Add a ${(slot.displayName ?? SLOT_LABELS[slot.type] ?? 'sub-node').toLowerCase()}`}
                  data-testid={`add-slot-${node.name}-${slot.type}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    editor.openCreator({ node: node.name, output: 0, slot: slot.type });
                  }}
                  className="nodrag nopan absolute left-1/2 top-8 flex size-5 -translate-x-1/2 -rotate-45 items-center justify-center rounded border border-line-strong bg-panel-3 text-muted opacity-0 transition-opacity hover:border-accent hover:text-fg group-hover/node:opacity-100"
                >
                  <Plus size={12} />
                </button>
              )}
            </Handle>
          );
        })}

        {inputs.map((input, i) => (
          <Handle
            key={`in-${i}`}
            id={`in-${i}`}
            type="target"
            position={Position.Left}
            style={{ top: handleTop(i, inputs.length) }}
            className="!size-3 !rounded-sm !border-2 !border-panel !bg-[#8a8a99] hover:!bg-accent"
          >
            {inputs.length > 1 && (
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] text-subtle">
                {input.displayName ?? `Input ${i + 1}`}
              </span>
            )}
          </Handle>
        ))}
        {outputs.map((output, i) => (
          <Handle
            key={`out-${i}`}
            id={`out-${i}`}
            type="source"
            position={Position.Right}
            style={{ top: handleTop(i, outputs.length) }}
            className={cn('!size-3 !rounded-full !border-2 !border-panel hover:!bg-accent', output.displayName === 'error' ? '!bg-danger' : '!bg-[#8a8a99]')}
          >
            {(outputs.length > 1 || output.displayName === 'error') && (
              <span className={cn('pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 whitespace-nowrap text-[10.5px]', output.displayName === 'error' ? 'text-danger' : 'text-muted')}>
                {output.displayName ?? i}
              </span>
            )}
            {!connectedOutputs.has(i) && (
              <button
                type="button"
                title="Add a node here"
                data-testid={`add-from-${node.name}-${i}`}
                onClick={(e) => {
                  e.stopPropagation();
                  editor.openCreator({ node: node.name, output: i });
                }}
                className={cn(
                  'nodrag nopan absolute top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded border border-line-strong bg-panel-3 text-muted opacity-0 transition-opacity hover:border-accent hover:text-fg group-hover/node:opacity-100',
                  outputs.length > 1 || output.displayName === 'error' ? 'left-[52px]' : 'left-6',
                )}
              >
                <Plus size={12} />
              </button>
            )}
          </Handle>
        ))}
      </div>
      <div className={cn('w-[150px] text-center', slots.length ? 'mt-9' : 'mt-2')}>
        {slots.length === 0 && <div className={cn('line-clamp-2 text-[12.5px] font-medium leading-tight', node.disabled && 'text-subtle line-through')}>{node.name}</div>}
        {subtitle && slots.length === 0 && <div className="truncate text-[11px] text-subtle">{subtitle}</div>}
        {live && live.status !== 'running' && (
          <div
            className={cn('text-[11px] font-medium', status === 'error' ? 'text-danger' : status === 'waiting' ? 'text-warning' : 'text-success')}
            data-testid="node-item-count"
          >
            {status === 'error' ? 'Error' : status === 'waiting' ? 'Waiting…' : plural(live.itemCount, 'item')}
            {live.runs > 1 && <span className="text-subtle"> · {live.runs} runs</span>}
          </div>
        )}
      </div>
    </div>
  );
});
