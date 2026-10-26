import { Link } from 'react-router';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  SelectionMode,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import { LayoutGrid, Maximize, Minus, MousePointerClick, Plus, StickyNote } from 'lucide-react';
import type { ConnectionType, NodeTypeInfo, WorkflowNode } from '@flowforge/shared';
import { aiSlots, fetchOutputs, isTriggerType, staticOutputs } from '../../lib/node-types';
import { edgeKey, listAllEdges, type EdgeRef } from '../graph';
import { editor, useEditor } from '../store';
import { FlowEdge } from './FlowEdge';
import { StickyNoteCard } from './StickyNoteCard';
import { NodeTypesCtx } from './types-context';
import { WorkflowNodeCard } from './WorkflowNodeCard';

export const NODE_DRAG_TYPE = 'application/x-flowforge-node';
const STICKY = 'flowforge.stickyNote';

const nodeTypes = { workflow: WorkflowNodeCard, sticky: StickyNoteCard };
const edgeTypes = { flow: FlowEdge };

const handleIndex = (handle: string | null | undefined) => Number(String(handle ?? '').split('-')[1] ?? 0);

/** "sub-ai_tool" (top of a sub-node) / "slot-ai_tool" (under a cluster node) → "ai_tool". */
const slotOf = (handle: string | null | undefined): ConnectionType | null => {
  const match = /^(?:sub|slot)-(ai_\w+)$/.exec(String(handle ?? ''));
  return match ? (match[1] as ConnectionType) : null;
};

/** Keeps outputs of Switch/Filter (computed on the server from their parameters) up to date. */
function useDynamicOutputs(types: Map<string, NodeTypeInfo>) {
  const nodes = useEditor((s) => s.nodes);
  const dynamic = useMemo(
    () => nodes.filter((n) => types.get(n.type)?.dynamicOutputs).map((n) => ({ node: n, key: JSON.stringify([n.parameters, n.onError]) })),
    [nodes, types],
  );
  const signature = dynamic.map((d) => `${d.node.id}:${d.key}`).join('|');
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const { node } of dynamic) {
        fetchOutputs(node)
          .then((outputs) => editor.setDynamicOutputs(node.id, outputs))
          .catch(() => undefined);
      }
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
}

export function Canvas({ types }: { types: Map<string, NodeTypeInfo> }) {
  const nodes = useEditor((s) => s.nodes);
  const connections = useEditor((s) => s.connections);
  const selected = useEditor((s) => s.selected);
  const dynamicOutputs = useEditor((s) => s.dynamicOutputs);
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [minimap, setMinimap] = useState(true);
  const rf = useReactFlow();
  useDynamicOutputs(types);

  // Fit the whole workflow once React Flow has measured the nodes (the fitView prop can run too early).
  const initialized = useNodesInitialized();
  const fitted = useRef(false);
  useEffect(() => {
    if (initialized && !fitted.current) {
      fitted.current = true;
      requestAnimationFrame(() => void rf.fitView({ padding: 0.25, maxZoom: 1 }));
    }
  }, [initialized, rf]);

  const byName = useMemo(() => new Map(nodes.map((n) => [n.name, n])), [nodes]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const rfNodes: Node[] = useMemo(
    () =>
      nodes.map((n) => {
        const sticky = n.type === STICKY;
        const p = n.parameters as { width?: number; height?: number };
        return {
          id: n.id,
          type: sticky ? 'sticky' : 'workflow',
          position: { x: n.position[0], y: n.position[1] },
          data: {},
          selected: selectedSet.has(n.id),
          ...(sticky ? { style: { width: p.width ?? 240, height: p.height ?? 160 }, zIndex: -1 } : {}),
          ...(measured[n.id] ? { measured: measured[n.id] } : {}),
        };
      }),
    [nodes, selectedSet, measured],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      listAllEdges(connections).flatMap((e) => {
        const source = byName.get(e.source);
        const target = byName.get(e.target);
        if (!source || !target) return [];
        const outputs = dynamicOutputs[source.id] ?? staticOutputs(types.get(source.type), source);
        const key = edgeKey(e);
        return [
          {
            id: key,
            source: source.id,
            target: target.id,
            // AI connections go from the top of a sub-node to a slot under its parent.
            sourceHandle: e.type && e.type !== 'main' ? `sub-${e.type}` : `out-${e.output}`,
            targetHandle: e.type && e.type !== 'main' ? `slot-${e.type}` : `in-${e.input}`,
            type: 'flow',
            selected: selectedEdges.has(key),
            data: { ref: e, key, error: outputs[e.output]?.displayName === 'error' },
          },
        ];
      }),
    [connections, byName, dynamicOutputs, types, selectedEdges],
  );

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const moves: Array<{ id: string; position: { x: number; y: number } }> = [];
    let selection: Set<string> | null = null;
    const dims: Record<string, { width: number; height: number }> = {};
    for (const c of changes) {
      if (c.type === 'position' && c.position) moves.push({ id: c.id, position: c.position });
      if (c.type === 'select') {
        selection ??= new Set(useEditor.getState().selected);
        if (c.selected) selection.add(c.id);
        else selection.delete(c.id);
      }
      if (c.type === 'dimensions' && c.dimensions) dims[c.id] = c.dimensions;
    }
    if (moves.length) editor.moveNodes(moves);
    if (selection) editor.select([...selection]);
    if (Object.keys(dims).length) setMeasured((m) => ({ ...m, ...dims }));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setSelectedEdges((current) => {
      let next: Set<string> | null = null;
      for (const c of changes) {
        if (c.type === 'select') {
          next ??= new Set(current);
          if (c.selected) next.add(c.id);
          else next.delete(c.id);
        }
      }
      return next ?? current;
    });
  }, []);

  const refOf = useCallback(
    (c: Connection | Edge): EdgeRef | null => {
      const s = useEditor.getState();
      const source = s.nodes.find((n) => n.id === c.source);
      const target = s.nodes.find((n) => n.id === c.target);
      if (!source || !target) return null;
      const slot = slotOf(c.sourceHandle);
      if (slot) return { source: source.name, output: 0, target: target.name, input: 0, type: slot };
      return { source: source.name, output: handleIndex(c.sourceHandle), target: target.name, input: handleIndex(c.targetHandle) };
    },
    [],
  );

  /** Data handles connect to data handles; a sub-node only plugs into a free slot of its own kind. */
  const canConnect = useCallback(
    (sourceHandle: string | null | undefined, targetHandle: string | null | undefined, targetId: string) => {
      const [from, to] = [slotOf(sourceHandle), slotOf(targetHandle)];
      if (!from && !to) return true;
      if (from !== to || !String(sourceHandle).startsWith('sub-') || !String(targetHandle).startsWith('slot-')) return false;
      const state = useEditor.getState();
      const target = state.nodes.find((n) => n.id === targetId);
      const max = aiSlots(target ? types.get(target.type) : undefined).find((slot) => slot.type === to)?.maxConnections;
      return max === undefined || listAllEdges(state.connections).filter((e) => e.target === target?.name && e.type === to).length < max;
    },
    [types],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const ref = refOf(c);
      if (ref) editor.connect(ref);
    },
    [refOf],
  );

  const onDelete = useCallback(
    ({ nodes: deleted, edges }: { nodes: Node[]; edges: Edge[] }) => {
      const s = useEditor.getState();
      const names = deleted.map((d) => s.nodes.find((n) => n.id === d.id)?.name).filter((n): n is string => Boolean(n));
      editor.deleteSelection(names, edges.map(refOf).filter((r): r is EdgeRef => r !== null));
      setSelectedEdges(new Set());
    },
    [refOf],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      const type = types.get(e.dataTransfer.getData(NODE_DRAG_TYPE));
      if (!type) return;
      e.preventDefault();
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const added = editor.addNode(type, { position: [p.x - 50, p.y - 50], connectFrom: useEditor.getState().creator.connectFrom ?? null });
      editor.closeCreator();
      if (!isTriggerType(type) && type.group !== 'note') editor.openPanel(added.name);
    },
    [rf, types],
  );

  const empty = !nodes.some((n) => n.type !== STICKY);

  return (
    <NodeTypesCtx.Provider value={types}>
      <div className="relative h-full w-full" onDragOver={(e) => e.dataTransfer.types.includes(NODE_DRAG_TYPE) && e.preventDefault()} onDrop={onDrop}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDelete={onDelete}
          onNodeDragStart={() => editor.beginChange(`drag:${Date.now()}`)}
          onSelectionDragStart={() => editor.beginChange(`drag:${Date.now()}`)}
          onNodeDoubleClick={(_e, n) => {
            const node = useEditor.getState().nodes.find((x) => x.id === n.id);
            if (node && node.type !== STICKY) editor.openPanel(node.name);
          }}
          onPaneClick={() => editor.closeCreator()}
          isValidConnection={(c) => c.source !== c.target && canConnect(c.sourceHandle, c.targetHandle, c.target)}
          deleteKeyCode={['Delete', 'Backspace']}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          panOnDrag={[1, 2]}
          panOnScroll
          zoomActivationKeyCode={['Control', 'Meta']}
          multiSelectionKeyCode={['Shift', 'Control', 'Meta']}
          snapToGrid
          snapGrid={[20, 20]}
          minZoom={0.15}
          maxZoom={2.5}
          fitView
          fitViewOptions={{ maxZoom: 1, padding: 0.25 }}
          connectionRadius={28}
          defaultEdgeOptions={{ type: 'flow' }}
          colorMode="dark"
          proOptions={{ hideAttribution: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#34343f" />
          {minimap && (
            <MiniMap
              pannable
              zoomable
              style={{ width: 150, height: 96 }}
              className="!rounded-lg !border !border-line !bg-panel"
              maskColor="rgba(10,10,14,0.6)"
              nodeColor={(n) => (n.type === 'sticky' ? '#5a5030' : '#3d3d4a')}
              nodeStrokeWidth={0}
            />
          )}
          <Panel position="top-right" className="flex flex-col gap-2">
            <CanvasButton testId="open-node-creator" title="Add node (Tab)" onClick={() => editor.openCreator()}>
              <Plus size={18} />
            </CanvasButton>
            <CanvasButton title="Add sticky note (Shift+S)" onClick={() => addSticky(types, rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }))}>
              <StickyNote size={16} />
            </CanvasButton>
          </Panel>
          <Panel position="bottom-left" className="flex gap-1.5">
            <CanvasButton title="Zoom in" onClick={() => void rf.zoomIn()}>
              <Plus size={15} />
            </CanvasButton>
            <CanvasButton title="Zoom out" onClick={() => void rf.zoomOut()}>
              <Minus size={15} />
            </CanvasButton>
            <CanvasButton testId="fit-view" title="Fit view (Shift+1)" onClick={() => void rf.fitView({ padding: 0.25, maxZoom: 1, duration: 300 })}>
              <Maximize size={15} />
            </CanvasButton>
            <CanvasButton
              testId="auto-layout"
              title="Tidy up (Shift+Alt+T)"
              onClick={() => {
                editor.layout((n) => n.type === STICKY);
                setTimeout(() => void rf.fitView({ padding: 0.25, maxZoom: 1, duration: 300 }), 50);
              }}
            >
              <LayoutGrid size={15} />
            </CanvasButton>
            <CanvasButton title="Toggle minimap" onClick={() => setMinimap((m) => !m)}>
              <span className="text-[10px] font-semibold">MAP</span>
            </CanvasButton>
          </Panel>
        </ReactFlow>
        {empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <button
              type="button"
              data-testid="canvas-add-first-step"
              onClick={() => editor.openCreator()}
              className="pointer-events-auto flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-line-strong p-8 text-muted transition-colors hover:border-accent hover:text-fg"
            >
              <span className="flex size-16 items-center justify-center rounded-xl bg-panel-2">
                <Plus size={30} />
              </span>
              <span className="text-[14px] font-medium">Add first step</span>
              <span className="flex items-center gap-1 text-[12px] text-subtle">
                <MousePointerClick size={13} /> or press Tab
              </span>
            </button>
            <div className="pointer-events-auto absolute bottom-24 left-1/2 w-[440px] max-w-[90%] -translate-x-1/2 rounded-xl border border-line bg-panel/90 px-4 py-3 text-[12.5px] text-muted shadow-lg" data-testid="canvas-onboarding">
              <div className="mb-1.5 font-medium text-fg">New here? Three ways to start</div>
              <ol className="list-decimal space-y-0.5 pl-5">
                <li>Click <b className="text-fg">Add first step</b> and pick a trigger (Manual, Form, Webhook, Schedule…).</li>
                <li>Describe your automation in one sentence in the AI bar at the top (or pick a suggestion).</li>
                <li>
                  Start from a{' '}
                  <Link to="/templates" className="text-accent-hover hover:underline">
                    ready-made template
                  </Link>
                  . Press <kbd className="rounded border border-line bg-panel-2 px-1 font-mono text-[11px]">?</kbd> for keyboard shortcuts.
                </li>
              </ol>
            </div>
          </div>
        )}
      </div>
    </NodeTypesCtx.Provider>
  );
}

function CanvasButton({ children, onClick, title, testId }: { children: React.ReactNode; onClick(): void; title: string; testId?: string }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      data-testid={testId}
      onClick={onClick}
      className="flex size-9 items-center justify-center rounded-lg border border-line-strong bg-panel text-muted shadow-lg shadow-black/30 transition-colors hover:border-accent hover:text-fg"
    >
      {children}
    </button>
  );
}

/** Adds a sticky note near `at`, moved up until it does not cover a node. */
export function addSticky(types: Map<string, NodeTypeInfo>, at: { x: number; y: number }): WorkflowNode | undefined {
  const type = types.get(STICKY);
  if (!type) return undefined;
  const [w, h] = [240, 160];
  const blockers = useEditor.getState().nodes.filter((n) => n.type !== STICKY);
  const overlaps = (x: number, y: number) =>
    blockers.some((n) => x < n.position[0] + 150 && x + w > n.position[0] - 50 && y < n.position[1] + 150 && y + h > n.position[1] - 20);
  let x = Math.round(at.x - w / 2);
  let y = Math.round(at.y - h / 2);
  for (let i = 0; i < 30 && overlaps(x, y); i++) y -= 60;
  return editor.addNode(type, { position: [x, y], connectFrom: null });
}
