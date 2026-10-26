import { create } from 'zustand';
import type {
  ConnectionSpec,
  Connections,
  ExecutionDetail,
  ExecutionStatus,
  Item,
  NodeRunStatus,
  NodeTypeInfo,
  RunData,
  SerializedError,
  ServerEvent,
  WorkflowData,
  ConnectionType,
  WorkflowNode,
  WorkflowRecord,
  WorkflowSettings,
} from '@flowforge/shared';
import {
  addEdge,
  AI_TYPES,
  autoLayout,
  copyPayload,
  edgeKey,
  listAllEdges,
  listEdges,
  pastePayload,
  removeEdges,
  removeNodeConnections,
  renameInWorkflow,
  uniqueName,
  SUB_GAP,
  SUB_ROW,
  type EdgeRef,
} from './graph';

/** Where a new node is attached: the output of a node, or (with `slot`) an AI slot of a cluster node. */
export interface ConnectFrom {
  node: string;
  output: number;
  slot?: ConnectionType;
}

export type LiveStatus = 'running' | 'waiting' | NodeRunStatus;

export interface NodeLive {
  status: LiveStatus;
  itemCount: number;
  runs: number;
  executionTime?: number;
  error?: SerializedError;
}

export interface LogEntry {
  node: string;
  runIndex: number;
  status: NodeRunStatus;
  executionTime: number;
  itemCounts: number[];
  error?: SerializedError;
}

export type RunState = 'idle' | 'starting' | 'queued' | 'running' | ExecutionStatus;

export interface ExecutionUi {
  id: string | null;
  status: RunState;
  destination?: string;
  lastSeq: number;
  startedAt?: number;
  finishedAt?: number;
  error?: SerializedError | null;
  /** Set while the execution is paused by a Wait node. */
  waiting?: { node: string; till: string | null; kind: 'time' | 'webhook' | 'form'; resumeUrl: string };
  nodes: Record<string, NodeLive>;
  /** Item counts and particle triggers per edge key. */
  edges: Record<string, { count: number; key: number }>;
  log: LogEntry[];
}

interface Snapshot {
  name: string;
  nodes: WorkflowNode[];
  connections: Connections;
  pinData: Record<string, Item[]>;
  settings: WorkflowSettings;
}

const ACTIVE: RunState[] = ['starting', 'queued', 'running', 'waiting'];
export const isRunning = (s: RunState) => ACTIVE.includes(s);

const emptyExecution = (): ExecutionUi => ({ id: null, status: 'idle', lastSeq: 0, nodes: {}, edges: {}, log: [] });

export interface EditorState {
  workflowId: string | null;
  versionId: string | null;
  name: string;
  nodes: WorkflowNode[];
  connections: Connections;
  settings: WorkflowSettings;
  pinData: Record<string, Item[]>;
  dirty: boolean;
  /** Activation state (from the server). */
  active: boolean;
  activationError: string | null;
  triggerError: string | null;
  /** "Listen for test event" in progress. */
  listening: { nodeName: string; testUrl?: string; method?: string; expiresAt?: string } | null;
  settingsOpen: boolean;
  /** Selected node ids. */
  selected: string[];
  past: Snapshot[];
  future: Snapshot[];
  lastCommitKey?: string;
  lastCommitAt: number;
  execution: ExecutionUi;
  runData: RunData | null;
  lastExecutionId: string | null;
  /** Outputs computed by the server for nodes with dynamic outputs (by node id). */
  dynamicOutputs: Record<string, ConnectionSpec[]>;
  openNode: string | null;
  creator: { open: boolean; connectFrom?: ConnectFrom };
  paletteOpen: boolean;
  helpOpen: boolean;
  logOpen: boolean;
  /** Test chat of a Chat Trigger (floating panel on the canvas). */
  chatOpen: boolean;
  /** Node names and edge keys that were just drawn by the AI builder (they pop / draw themselves). */
  fresh: string[];
  /** Per node name: credentials that are not configured yet (warning badge on the canvas). */
  missingCredentials: Record<string, string[]>;
  clipboard: string | null;
}

const initial = (): EditorState => ({
  workflowId: null,
  versionId: null,
  name: '',
  nodes: [],
  connections: {},
  settings: {},
  pinData: {},
  dirty: false,
  active: false,
  activationError: null,
  triggerError: null,
  listening: null,
  settingsOpen: false,
  selected: [],
  past: [],
  future: [],
  lastCommitAt: 0,
  execution: emptyExecution(),
  runData: null,
  lastExecutionId: null,
  dynamicOutputs: {},
  openNode: null,
  creator: { open: false },
  paletteOpen: false,
  helpOpen: false,
  logOpen: false,
  chatOpen: false,
  fresh: [],
  missingCredentials: {},
  clipboard: null,
});

export const useEditor = create<EditorState>(() => initial());

const get = () => useEditor.getState();
const set = (partial: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)) => useEditor.setState(partial);

const snapshot = (s: EditorState): Snapshot => ({
  name: s.name,
  nodes: s.nodes,
  connections: s.connections,
  pinData: s.pinData,
  settings: s.settings,
});

/**
 * Applies a change and records an undo step. Changes with the same `key` within 1.5 s are merged
 * into one step (typing in a parameter field should not create one step per key press).
 */
function commit(mutate: (s: EditorState) => Partial<EditorState>, key?: string) {
  const s = get();
  const now = Date.now();
  const merge = key !== undefined && s.lastCommitKey === key && now - s.lastCommitAt < 1500;
  set({
    ...(merge ? {} : { past: [...s.past.slice(-99), snapshot(s)], future: [] }),
    ...mutate(s),
    dirty: true,
    lastCommitKey: key,
    lastCommitAt: now,
  });
}

const byName = (name: string) => get().nodes.find((n) => n.name === name);

export function workflowData(s: EditorState = get()): WorkflowData {
  return {
    ...(s.workflowId ? { id: s.workflowId } : {}),
    name: s.name,
    nodes: s.nodes,
    connections: s.connections,
    settings: s.settings,
    pinData: s.pinData,
  };
}

export const editor = {
  reset() {
    set(initial());
  },

  load(record: WorkflowRecord) {
    set({
      ...initial(),
      workflowId: record.id,
      versionId: record.versionId,
      name: record.name,
      nodes: record.nodes,
      connections: record.connections,
      settings: record.settings ?? {},
      pinData: record.pinData ?? {},
      active: record.active,
      activationError: record.activationError,
      triggerError: record.triggerError,
    });
  },

  setActivation(info: { active: boolean; activationError?: string | null; triggerError?: string | null }) {
    set((s) => ({
      active: info.active,
      activationError: info.activationError === undefined ? s.activationError : info.activationError,
      triggerError: info.triggerError === undefined ? s.triggerError : info.triggerError,
    }));
  },

  setSettings(settings: WorkflowSettings) {
    commit(() => ({ settings }));
  },

  setListening(listening: EditorState['listening']) {
    set({ listening });
  },

  markSaved(record: WorkflowRecord) {
    set({ versionId: record.versionId, dirty: false });
  },

  setName(name: string) {
    commit(() => ({ name }), 'workflow-name');
  },

  /** Records an undo step before a continuous change (drag, resize). */
  beginChange(key: string) {
    commit(() => ({}), key);
  },

  addNode(
    type: NodeTypeInfo,
    options: { position?: [number, number]; connectFrom?: ConnectFrom | null; parameters?: WorkflowNode['parameters'] } = {},
  ): WorkflowNode {
    const s = get();
    const name = uniqueName(type.defaults.name, new Set(s.nodes.map((n) => n.name)));
    const isNote = type.group === 'note';
    let source = options.connectFrom === undefined ? null : options.connectFrom;
    if (options.connectFrom === undefined && !isNote && type.inputs.length > 0 && s.selected.length === 1) {
      const sel = s.nodes.find((n) => n.id === s.selected[0]);
      if (sel && sel.type !== 'flowforge.stickyNote') source = { node: sel.name, output: 0 };
    }
    const from = source ? s.nodes.find((n) => n.name === source!.node) : undefined;
    // A sub-node added from an AI slot goes under its parent and plugs into that slot.
    const slot = from ? source?.slot : undefined;
    let position = options.position;
    if (!position && from && slot) {
      const index = Math.max(0, AI_TYPES.indexOf(slot) - 1);
      position = [from.position[0] + index * SUB_GAP, from.position[1] + SUB_ROW];
      while (s.nodes.some((n) => Math.abs(n.position[0] - position![0]) < 60 && Math.abs(n.position[1] - position![1]) < 60)) position = [position[0] + SUB_GAP, position[1]];
    }
    if (!position && from) {
      position = [from.position[0] + 240, from.position[1] + (source!.output > 0 ? source!.output * 140 : 0)];
    }
    if (!position) {
      const right = s.nodes.filter((n) => n.type !== 'flowforge.stickyNote').reduce((max, n) => Math.max(max, n.position[0]), -240);
      position = [right + 240, 200];
    }
    // Avoid stacking exactly on top of another node.
    while (s.nodes.some((n) => Math.abs(n.position[0] - position![0]) < 40 && Math.abs(n.position[1] - position![1]) < 40)) {
      position = [position[0], position[1] + 140];
    }
    const node: WorkflowNode = {
      id: crypto.randomUUID(),
      name,
      type: type.type,
      typeVersion: type.version,
      position: [Math.round(position[0]), Math.round(position[1])],
      parameters: options.parameters ?? {},
    };
    commit((st) => ({
      nodes: [...st.nodes, node],
      connections: from && slot
        ? addEdge(st.connections, { source: name, output: 0, target: from.name, input: 0, type: slot })
        : from && type.inputs.some((i) => i.type === 'main')
          ? addEdge(st.connections, { source: from.name, output: source!.output, target: name, input: 0 })
          : st.connections,
      selected: [node.id],
    }));
    return node;
  },

  deleteNodes(names: string[]) {
    if (!names.length) return;
    const remove = new Set(names);
    commit((s) => ({
      nodes: s.nodes.filter((n) => !remove.has(n.name)),
      connections: removeNodeConnections(s.connections, remove),
      pinData: Object.fromEntries(Object.entries(s.pinData).filter(([k]) => !remove.has(k))),
      selected: s.selected.filter((id) => !s.nodes.some((n) => n.id === id && remove.has(n.name))),
      openNode: s.openNode && remove.has(s.openNode) ? null : s.openNode,
    }));
  },

  connect(edge: EdgeRef) {
    if (edge.source === edge.target) return;
    commit((s) => ({ connections: addEdge(s.connections, edge) }));
  },

  disconnect(edges: EdgeRef[]) {
    if (!edges.length) return;
    commit((s) => ({ connections: removeEdges(s.connections, edges) }));
  },

  /** Removes nodes and edges in one undo step (Delete key). */
  deleteSelection(nodeNames: string[], edges: EdgeRef[]) {
    if (!nodeNames.length && !edges.length) return;
    const remove = new Set(nodeNames);
    commit((s) => ({
      nodes: s.nodes.filter((n) => !remove.has(n.name)),
      connections: removeNodeConnections(removeEdges(s.connections, edges), remove),
      pinData: Object.fromEntries(Object.entries(s.pinData).filter(([k]) => !remove.has(k))),
      selected: [],
      openNode: s.openNode && remove.has(s.openNode) ? null : s.openNode,
    }));
  },

  /** Positions during a drag (the undo step was recorded by beginChange). */
  moveNodes(moves: Array<{ id: string; position: { x: number; y: number } }>) {
    const map = new Map(moves.map((m) => [m.id, m.position]));
    set((s) => ({
      nodes: s.nodes.map((n) => {
        const p = map.get(n.id);
        return p ? { ...n, position: [Math.round(p.x), Math.round(p.y)] as [number, number] } : n;
      }),
      dirty: true,
    }));
  },

  select(ids: string[]) {
    const current = get().selected;
    if (current.length === ids.length && current.every((id, i) => id === ids[i])) return;
    set({ selected: ids });
  },

  selectAll() {
    set((s) => ({ selected: s.nodes.map((n) => n.id) }));
  },

  /** Returns an error message if the name is not valid. */
  renameNode(from: string, toRaw: string): string | null {
    const to = toRaw.trim();
    if (!to) return 'The name cannot be empty';
    if (to === from) return null;
    if (get().nodes.some((n) => n.name === to)) return `A node named "${to}" already exists`;
    commit((s) => ({
      ...renameInWorkflow(s, from, to),
      openNode: s.openNode === from ? to : s.openNode,
      runData: s.runData && s.runData[from] ? { ...s.runData, [to]: s.runData[from]! } : s.runData,
    }));
    return null;
  },

  updateParameters(name: string, parameters: WorkflowNode['parameters'], key?: string) {
    commit((s) => ({ nodes: s.nodes.map((n) => (n.name === name ? { ...n, parameters } : n)) }), key ?? `params:${name}`);
  },

  updateNode(name: string, patch: Partial<Omit<WorkflowNode, 'name' | 'id'>>, key?: string) {
    commit((s) => ({ nodes: s.nodes.map((n) => (n.name === name ? { ...n, ...patch } : n)) }), key);
  },

  toggleDisabled(names: string[]) {
    if (!names.length) return;
    const nodes = get().nodes.filter((n) => names.includes(n.name));
    const disable = nodes.some((n) => !n.disabled);
    commit((s) => ({ nodes: s.nodes.map((n) => (names.includes(n.name) ? { ...n, disabled: disable || undefined } : n)) }));
  },

  pin(name: string, items: Item[]) {
    commit((s) => ({ pinData: { ...s.pinData, [name]: items.map((i) => ({ json: i.json, ...(i.binary ? { binary: i.binary } : {}) })) } }));
  },

  unpin(name: string) {
    commit((s) => {
      const pinData = { ...s.pinData };
      delete pinData[name];
      return { pinData };
    });
  },

  copy(names: string[]): string | null {
    if (!names.length) return null;
    const s = get();
    const text = copyPayload(s.nodes, s.connections, new Set(names));
    set({ clipboard: text });
    return text;
  },

  /** Pastes clipboard JSON; returns the number of pasted nodes. */
  paste(text: string | null, offset: [number, number] = [40, 40]): number {
    const source = text ?? get().clipboard;
    if (!source) return 0;
    const pasted = pastePayload(source, get().nodes, offset);
    if (!pasted || !pasted.nodes.length) return 0;
    commit((s) => {
      let connections = s.connections;
      for (const e of listAllEdges(pasted.connections)) connections = addEdge(connections, e);
      return { nodes: [...s.nodes, ...pasted.nodes], connections, selected: pasted.nodes.map((n) => n.id) };
    });
    return pasted.nodes.length;
  },

  duplicate(names: string[]): number {
    const text = editor.copy(names);
    return text ? editor.paste(text, [40, 60]) : 0;
  },

  layout(isNote: (n: WorkflowNode) => boolean) {
    const s = get();
    const positions = autoLayout(s.nodes, s.connections, isNote);
    commit((st) => ({ nodes: st.nodes.map((n) => (positions.has(n.name) ? { ...n, position: positions.get(n.name)! } : n)) }));
  },

  undo() {
    const s = get();
    const previous = s.past[s.past.length - 1];
    if (!previous) return;
    set({ ...previous, past: s.past.slice(0, -1), future: [snapshot(s), ...s.future], dirty: true, lastCommitKey: undefined });
    editor.pruneSelection();
  },

  redo() {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    set({ ...next, future: s.future.slice(1), past: [...s.past, snapshot(s)], dirty: true, lastCommitKey: undefined });
    editor.pruneSelection();
  },

  pruneSelection() {
    const s = get();
    const ids = new Set(s.nodes.map((n) => n.id));
    set({ selected: s.selected.filter((id) => ids.has(id)), openNode: s.openNode && byName(s.openNode) ? s.openNode : null });
  },

  setDynamicOutputs(id: string, outputs: ConnectionSpec[]) {
    set((s) => ({ dynamicOutputs: { ...s.dynamicOutputs, [id]: outputs } }));
  },

  openPanel(name: string | null) {
    set({ openNode: name, creator: { open: false } });
  },

  openCreator(connectFrom?: ConnectFrom) {
    set({ creator: { open: true, connectFrom }, paletteOpen: false });
  },

  closeCreator() {
    set({ creator: { open: false } });
  },

  setUi(patch: Partial<Pick<EditorState, 'paletteOpen' | 'helpOpen' | 'logOpen' | 'settingsOpen' | 'chatOpen'>>) {
    set(patch);
  },

  setMissingCredentials(missingCredentials: EditorState['missingCredentials']) {
    set({ missingCredentials });
  },

  /**
   * AI builder: one drawing step (the steps of one build merge into a single undo step).
   * `fresh` lists the node names / edge keys that were just added: they animate, then `settle()` clears them.
   */
  buildStep(patch: Partial<Pick<EditorState, 'nodes' | 'connections' | 'name' | 'pinData'>>, fresh: string[] = []) {
    commit(() => ({ ...patch, selected: [] }), 'ai-build');
    set({ fresh: [...get().fresh, ...fresh] });
  },

  settle(names: string[]) {
    const done = new Set(names);
    set({ fresh: get().fresh.filter((f) => !done.has(f)) });
  },

  // ── execution ──────────────────────────────────────────────────────────

  prepareRun(destination?: string) {
    set({ execution: { ...emptyExecution(), status: 'starting', destination }, logOpen: true });
  },

  runFailedToStart(error: SerializedError) {
    set((s) => ({ execution: { ...s.execution, status: 'error', error } }));
  },

  /** Applies a live event. Returns what the caller should do next. */
  applyEvent(event: ServerEvent): 'finished' | 'refetch' | null {
    const s = get();
    // Workflow-level events (activation, test listeners) are broadcast to everyone: keep ours.
    if (event.type.startsWith('workflow.') || event.type.startsWith('trigger.')) {
      const d = event.data as { workflowId?: string };
      if (d.workflowId !== s.workflowId) return null;
      if (event.type === 'workflow.activated') set({ active: true, activationError: null, triggerError: null });
      if (event.type === 'workflow.deactivated') set({ active: false, triggerError: null });
      if (event.type === 'workflow.activationError') {
        const e = event.data;
        set(e.runtime ? { triggerError: e.message } : { active: false, activationError: e.message });
      }
      if (event.type === 'trigger.listening') {
        const e = event.data;
        set({ listening: { nodeName: e.nodeName, testUrl: e.testUrl, method: e.method, expiresAt: e.expiresAt } });
      }
      if (event.type === 'trigger.received' || event.type === 'trigger.stopped') set({ listening: null });
      return null;
    }
    const data = event.data as { executionId?: string };
    if (!data.executionId) return null;
    let ex = s.execution;

    if (event.type === 'execution.queued' || event.type === 'execution.started') {
      if (ex.id !== data.executionId) {
        // A new run of this workflow (ours, or one started in another tab): follow it.
        if (ex.id && isRunning(ex.status) && ex.status !== 'starting') return null;
        ex = { ...emptyExecution(), destination: ex.status === 'starting' ? ex.destination : undefined, id: data.executionId, status: 'queued' };
      }
      if (event.type === 'execution.started') {
        // A resumed execution keeps its node states; only the waiting marker goes away.
        const wasWaiting = ex.status === 'waiting' && ex.waiting;
        const nodes = wasWaiting ? Object.fromEntries(Object.entries(ex.nodes).filter(([, n]) => n.status !== 'waiting')) : ex.nodes;
        ex = { ...ex, nodes, status: 'running', waiting: undefined, startedAt: ex.startedAt ?? Date.parse(event.data.startedAt), lastSeq: event.seq ?? 0 };
      }
      set({ execution: ex, logOpen: true });
      return null;
    }
    if (ex.id !== data.executionId) return null;

    let gap = false;
    if (event.seq !== undefined) {
      gap = ex.lastSeq > 0 && event.seq > ex.lastSeq + 1;
      ex = { ...ex, lastSeq: Math.max(ex.lastSeq, event.seq) };
    }

    switch (event.type) {
      case 'node.started': {
        const prev = ex.nodes[event.data.nodeName];
        ex = { ...ex, nodes: { ...ex.nodes, [event.data.nodeName]: { status: 'running', itemCount: prev?.itemCount ?? 0, runs: prev?.runs ?? 0 } } };
        break;
      }
      case 'node.finished': {
        const d = event.data;
        ex = {
          ...ex,
          nodes: {
            ...ex.nodes,
            [d.nodeName]: {
              status: d.status,
              itemCount: d.itemCounts.reduce((a, b) => a + b, 0),
              runs: d.runIndex + 1,
              executionTime: d.executionTime,
              error: d.error,
            },
          },
          log: [...ex.log, { node: d.nodeName, runIndex: d.runIndex, status: d.status, executionTime: d.executionTime, itemCounts: d.itemCounts, error: d.error }],
        };
        break;
      }
      case 'edge.data': {
        const d = event.data;
        const key = edgeKey({ source: d.from.node, output: d.from.output, target: d.to.node, input: d.to.input });
        ex = { ...ex, edges: { ...ex.edges, [key]: { count: d.itemCount, key: event.ts + Math.random() } } };
        break;
      }
      case 'execution.waiting': {
        const d = event.data;
        const prev = ex.nodes[d.nodeName];
        ex = {
          ...ex,
          status: 'waiting',
          waiting: { node: d.nodeName, till: d.waitTill, kind: d.kind, resumeUrl: d.resumeUrl },
          nodes: { ...ex.nodes, [d.nodeName]: { status: 'waiting', itemCount: prev?.itemCount ?? 0, runs: prev?.runs ?? 0 } },
        };
        set({ execution: ex });
        return null;
      }
      case 'execution.finished': {
        ex = { ...ex, status: event.data.status, finishedAt: Date.parse(event.data.stoppedAt), error: event.data.error ?? null };
        set({ execution: ex });
        return 'finished';
      }
    }
    set({ execution: ex });
    return gap ? 'refetch' : null;
  },

  /** Final state from the stored execution (full run data for the node panel). */
  finishFromDetail(detail: ExecutionDetail) {
    const nodes: Record<string, NodeLive> = {};
    for (const [name, runs] of Object.entries(detail.runData)) {
      const last = runs[runs.length - 1]!;
      nodes[name] = {
        status: last.status,
        itemCount: last.data.main.reduce((a, l) => a + l.length, 0),
        runs: runs.length,
        executionTime: last.executionTime,
        error: last.error,
      };
    }
    const edges: ExecutionUi['edges'] = {};
    const s = get();
    for (const e of listEdges(s.connections)) {
      const runs = detail.runData[e.source];
      const count = runs?.[runs.length - 1]?.data.main[e.output]?.length ?? 0;
      if (count > 0 && detail.runData[e.target]) edges[edgeKey(e)] = { count, key: s.execution.edges[edgeKey(e)]?.key ?? 0 };
    }
    const log: LogEntry[] = detail.events
      .filter((ev) => ev.type === 'node.finished')
      .map((ev) => {
        const run = detail.runData[ev.node]?.[ev.runIndex];
        return {
          node: ev.node,
          runIndex: ev.runIndex,
          status: ev.status ?? 'success',
          executionTime: run?.executionTime ?? 0,
          itemCounts: run?.data.main.map((l) => l.length) ?? [],
          error: run?.error,
        };
      });
    set({
      runData: detail.runData,
      lastExecutionId: detail.id,
      execution: {
        ...s.execution,
        id: detail.id,
        status: detail.status,
        startedAt: detail.startedAt ? Date.parse(detail.startedAt) : s.execution.startedAt,
        finishedAt: detail.stoppedAt ? Date.parse(detail.stoppedAt) : s.execution.finishedAt,
        error: detail.error,
        nodes,
        edges,
        log,
      },
    });
  },
};

export const useNodeByName = (name: string | null) => useEditor((s) => (name ? s.nodes.find((n) => n.name === name) : undefined));
