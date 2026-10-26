// Positions for a generated workflow: main flow left to right with dagre (same look as the editor's Auto-layout),
// AI sub-nodes (Chat Model, Memory, Tools) in a row right under the node that uses them.
import dagre from '@dagrejs/dagre';
import type { Connections, WorkflowNode } from '@flowforge/shared';

/** Same numbers as `autoLayout` in web/src/editor/graph.ts. */
const NODE_SIZE = 100;
const BOX_HEIGHT = NODE_SIZE + 40;
const NODE_SEP = 70;
const RANK_SEP = 130;
const MARGIN = 40;
const SUB_STEP = NODE_SIZE + 40;
/** Distance between a parent and its row of sub-nodes (top to top). */
const SUB_DROP = 190;
const SLOT_ORDER = ['ai_languageModel', 'ai_memory', 'ai_tool'];

const snap = (n: number) => Math.round(n / 20) * 20;

/** Sub-nodes grouped by the node they are attached to, in slot order (model, memory, tools). */
export function subNodesByParent(nodes: WorkflowNode[], connections: Connections): Map<string, string[]> {
  const order = new Map(nodes.map((n, i) => [n.name, i]));
  const found: { parent: string; sub: string; slot: number }[] = [];
  for (const [source, byType] of Object.entries(connections)) {
    for (const [type, lists] of Object.entries(byType)) {
      const slot = SLOT_ORDER.indexOf(type);
      if (slot < 0 || !order.has(source)) continue;
      for (const list of lists ?? []) for (const t of list) if (order.has(t.node)) found.push({ parent: t.node, sub: source, slot });
    }
  }
  const out = new Map<string, string[]>();
  const placed = new Set<string>();
  for (const f of found.sort((a, b) => a.slot - b.slot || order.get(a.sub)! - order.get(b.sub)!)) {
    if (placed.has(f.sub)) continue; // a sub-node shared by two parents is drawn under the first
    placed.add(f.sub);
    out.set(f.parent, [...(out.get(f.parent) ?? []), f.sub]);
  }
  return out;
}

/** Sets `position` (integers, multiples of 20) on every node. Mutates the nodes. */
export function layoutNodes(nodes: WorkflowNode[], connections: Connections): void {
  if (nodes.length === 0) return;
  const subs = subNodesByParent(nodes, connections);
  const subNames = new Set([...subs.values()].flat());
  const main = nodes.filter((n) => !subNames.has(n.name));

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: MARGIN, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of main) {
    const count = subs.get(n.name)?.length ?? 0;
    // A parent reserves room above and below so its row of sub-nodes can never touch another node.
    const width = count ? Math.max(NODE_SIZE, count * SUB_STEP - (SUB_STEP - NODE_SIZE)) : NODE_SIZE;
    const height = count ? BOX_HEIGHT + 2 * SUB_DROP : BOX_HEIGHT;
    g.setNode(n.name, { width, height });
  }
  for (const [source, byType] of Object.entries(connections)) {
    const lists = byType.main ?? [];
    for (const list of lists) for (const t of list) if (g.hasNode(source) && g.hasNode(t.node) && source !== t.node) g.setEdge(source, t.node);
  }
  dagre.layout(g);

  const raw = new Map<string, [number, number]>();
  for (const n of main) {
    const p = g.node(n.name);
    const cx = p.x;
    const cy = p.y;
    raw.set(n.name, [cx - NODE_SIZE / 2, cy - NODE_SIZE / 2]);
    const list = subs.get(n.name) ?? [];
    const rowWidth = list.length * SUB_STEP - (SUB_STEP - NODE_SIZE);
    list.forEach((name, i) => raw.set(name, [cx - rowWidth / 2 + i * SUB_STEP, cy - NODE_SIZE / 2 + SUB_DROP]));
  }
  const minX = Math.min(...[...raw.values()].map((p) => p[0]));
  const minY = Math.min(...[...raw.values()].map((p) => p[1]));
  for (const n of nodes) {
    const p = raw.get(n.name) ?? [0, 0];
    n.position = [snap(p[0] - minX + MARGIN), snap(p[1] - minY + MARGIN)];
  }
}
