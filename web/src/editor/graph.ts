import dagre from '@dagrejs/dagre';
import type { Connections, ConnectionTarget, ConnectionType, Item, JsonObject, WorkflowNode } from '@flowforge/shared';

/**
 * A connection, by node names. `type` is "main" unless given: the AI types (ai_languageModel, ai_memory, ai_tool)
 * go FROM a sub-node TO the slot of its parent.
 */
export interface EdgeRef {
  source: string;
  output: number;
  target: string;
  input: number;
  type?: ConnectionType;
}

export const AI_TYPES: ConnectionType[] = ['ai_languageModel', 'ai_memory', 'ai_tool'];
const typeOf = (e: EdgeRef): ConnectionType => e.type ?? 'main';

export const edgeKey = (e: EdgeRef) => `${typeOf(e) === 'main' ? '' : `${typeOf(e)}|`}${encodeURIComponent(e.source)}:${e.output}->${encodeURIComponent(e.target)}:${e.input}`;

/** Main connections only (the data flow). Use `listAllEdges` to include the AI sub-node connections. */
export function listEdges(connections: Connections): EdgeRef[] {
  return listAllEdges(connections).filter((e) => typeOf(e) === 'main');
}

export function listAllEdges(connections: Connections): EdgeRef[] {
  const edges: EdgeRef[] = [];
  for (const [source, byType] of Object.entries(connections)) {
    for (const [type, outputs] of Object.entries(byType) as [ConnectionType, ConnectionTarget[][] | undefined][]) {
      (outputs ?? []).forEach((targets, output) => {
        for (const t of targets ?? []) edges.push({ source, output, target: t.node, input: t.index ?? 0, ...(type === 'main' ? {} : { type }) });
      });
    }
  }
  return edges;
}

export function addEdge(connections: Connections, e: EdgeRef): Connections {
  if (e.source === e.target) return connections;
  if (listAllEdges(connections).some((x) => edgeKey(x) === edgeKey(e))) return connections;
  const type = typeOf(e);
  const outputs = [...(connections[e.source]?.[type] ?? [])];
  while (outputs.length <= e.output) outputs.push([]);
  outputs[e.output] = [...(outputs[e.output] ?? []), { node: e.target, type, index: e.input }];
  return { ...connections, [e.source]: { ...connections[e.source], [type]: outputs } };
}

export function removeEdges(connections: Connections, edges: EdgeRef[]): Connections {
  const remove = new Set(edges.map(edgeKey));
  const out: Connections = {};
  for (const [source, byType] of Object.entries(connections)) {
    const kept: Connections[string] = {};
    for (const [type, outputs] of Object.entries(byType) as [ConnectionType, ConnectionTarget[][] | undefined][]) {
      const list = (outputs ?? []).map((targets, output) =>
        (targets ?? []).filter((t) => !remove.has(edgeKey({ source, output, target: t.node, input: t.index ?? 0, ...(type === 'main' ? {} : { type }) }))),
      );
      while (list.length && list[list.length - 1]!.length === 0) list.pop();
      if (list.length) kept[type] = list;
    }
    if (Object.keys(kept).length) out[source] = kept;
  }
  return out;
}

/** Drops every connection from or to the given nodes. */
export function removeNodeConnections(connections: Connections, names: Set<string>): Connections {
  return removeEdges(
    connections,
    listAllEdges(connections).filter((e) => names.has(e.source) || names.has(e.target)),
  );
}

/** n8n-style unique names: "Edit Fields", "Edit Fields1", "Edit Fields2"… */
export function uniqueName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  const stem = base.replace(/\d+$/, '');
  let n = 1;
  while (existing.has(`${stem}${n}`)) n++;
  return `${stem}${n}`;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function renameInValue(value: unknown, from: string, to: string): unknown {
  if (typeof value === 'string') {
    if (!value.includes(from)) return value;
    const name = escapeRegex(from);
    return value
      .replace(new RegExp(`(\\$\\(\\s*['"\`])${name}(['"\`]\\s*\\))`, 'g'), `$1${to}$2`)
      .replace(new RegExp(`(\\$node\\[\\s*['"])${name}(['"]\\s*\\])`, 'g'), `$1${to}$2`)
      .replace(new RegExp(`(\\$items\\(\\s*['"])${name}(['"])`, 'g'), `$1${to}$2`);
  }
  if (Array.isArray(value)) return value.map((v) => renameInValue(v, from, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameInValue(v, from, to)]));
  }
  return value;
}

/** Renames a node and updates connections, pinned data and expressions that reference it. */
export function renameInWorkflow(
  state: { nodes: WorkflowNode[]; connections: Connections; pinData: Record<string, Item[]> },
  from: string,
  to: string,
) {
  const nodes = state.nodes.map((n) => ({
    ...(n.name === from ? { ...n, name: to } : n),
    parameters: renameInValue(n.parameters, from, to) as JsonObject,
  }));
  const connections: Connections = {};
  for (const [source, byType] of Object.entries(state.connections)) {
    const renamed: Connections[string] = {};
    for (const [type, outputs] of Object.entries(byType) as [ConnectionType, ConnectionTarget[][] | undefined][]) {
      renamed[type] = (outputs ?? []).map((targets) => (targets ?? []).map((t): ConnectionTarget => (t.node === from ? { ...t, node: to } : t)));
    }
    connections[source === from ? to : source] = renamed;
  }
  const pinData = Object.fromEntries(Object.entries(state.pinData).map(([k, v]) => [k === from ? to : k, v]));
  return { nodes, connections, pinData };
}

export interface ClipboardPayload {
  flowforge: 1;
  nodes: WorkflowNode[];
  connections: Connections;
}

export function copyPayload(nodes: WorkflowNode[], connections: Connections, names: Set<string>): string {
  const picked = nodes.filter((n) => names.has(n.name));
  const internal = listAllEdges(connections).filter((e) => names.has(e.source) && names.has(e.target));
  const payload: ClipboardPayload = { flowforge: 1, nodes: picked, connections: internal.reduce(addEdge, {} as Connections) };
  return JSON.stringify(payload, null, 2);
}

/** Parses clipboard text (FlowForge or n8n-like JSON) into renamed copies placed at an offset. */
export function pastePayload(text: string, existing: WorkflowNode[], offset: [number, number]): { nodes: WorkflowNode[]; connections: Connections } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const data = parsed as Partial<ClipboardPayload>;
  if (!data || !Array.isArray(data.nodes) || data.nodes.some((n) => !n || typeof n.name !== 'string' || typeof n.type !== 'string')) return null;
  const taken = new Set(existing.map((n) => n.name));
  const rename = new Map<string, string>();
  const nodes = data.nodes.map((n) => {
    const name = uniqueName(n.name, taken);
    taken.add(name);
    rename.set(n.name, name);
    const [x, y] = Array.isArray(n.position) ? n.position : [0, 0];
    return { ...n, id: crypto.randomUUID(), name, position: [x + offset[0], y + offset[1]] as [number, number], parameters: n.parameters ?? {} };
  });
  let connections: Connections = {};
  for (const e of listAllEdges((data.connections ?? {}) as Connections)) {
    const source = rename.get(e.source);
    const target = rename.get(e.target);
    if (source && target) connections = addEdge(connections, { ...e, source, target });
  }
  return { nodes, connections };
}

export const NODE_SIZE = 100;
/** A node with AI slots is wider; its sub-nodes are smaller circles in a row below it. */
export const CLUSTER_WIDTH = 260;
export const SUB_SIZE = 80;
export const SUB_GAP = 150;
export const SUB_ROW = 200;

/** Left-to-right layout with dagre (sticky notes keep their position). */
export function autoLayout(nodes: WorkflowNode[], connections: Connections, isNote: (n: WorkflowNode) => boolean): Map<string, [number, number]> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 70, ranksep: 130, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  // Sub-nodes (attached to an AI slot) are not part of the flow: they are placed in a row under their parent.
  const attached = new Map<string, string>();
  for (const e of listAllEdges(connections)) if (typeOf(e) !== 'main') attached.set(e.source, e.target);
  const hasSubs = new Set(attached.values());
  const laid = nodes.filter((n) => !isNote(n) && !attached.has(n.name));
  // A parent reserves the room of its row of sub-nodes: as wide as the row, and as high above as below, so that
  // it stays on the same line as its neighbours.
  const subCount = new Map<string, number>();
  for (const parent of attached.values()) subCount.set(parent, (subCount.get(parent) ?? 0) + 1);
  for (const n of laid) {
    const subs = subCount.get(n.name) ?? 0;
    g.setNode(n.name, {
      width: subs ? Math.max(CLUSTER_WIDTH, (subs - 1) * SUB_GAP + SUB_SIZE + 60) : NODE_SIZE,
      height: NODE_SIZE + 40 + (subs ? 2 * SUB_ROW : 0),
    });
  }
  for (const e of listEdges(connections)) if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const minX = Math.min(...laid.map((n) => n.position[0]));
  const minY = Math.min(...laid.map((n) => n.position[1]));
  const out = new Map<string, [number, number]>();
  const xs = laid.map((n) => g.node(n.name).x);
  const ys = laid.map((n) => g.node(n.name).y);
  const offsetX = (Number.isFinite(minX) ? minX : 0) - Math.min(...xs);
  const offsetY = (Number.isFinite(minY) ? minY : 0) - Math.min(...ys);
  for (const n of laid) {
    const p = g.node(n.name);
    // dagre gives centres: a wide cluster node starts further left than a normal one.
    const shift = hasSubs.has(n.name) ? (CLUSTER_WIDTH - NODE_SIZE) / 2 : 0;
    out.set(n.name, [Math.round((p.x + offsetX - shift) / 20) * 20, Math.round((p.y + offsetY) / 20) * 20]);
  }
  for (const parent of hasSubs) {
    const at = out.get(parent);
    if (!at) continue;
    const order: Record<string, number> = { ai_languageModel: 0, ai_memory: 1, ai_tool: 2 };
    const typeFor = (name: string) => listAllEdges(connections).find((e) => e.source === name && e.target === parent)?.type ?? 'ai_tool';
    const subs = nodes
      .filter((n) => attached.get(n.name) === parent)
      .sort((a, b) => (order[typeFor(a.name)] ?? 9) - (order[typeFor(b.name)] ?? 9) || a.position[0] - b.position[0]);
    const start = at[0] + CLUSTER_WIDTH / 2 - ((subs.length - 1) * SUB_GAP) / 2 - SUB_SIZE / 2;
    subs.forEach((n, i) => out.set(n.name, [Math.round((start + i * SUB_GAP) / 20) * 20, at[1] + SUB_ROW]));
  }
  return out;
}
