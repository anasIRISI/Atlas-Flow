import type { Connections, WorkflowNode } from '@flowforge/shared';

const W = 46;
const H = 30;

/** Small read-only drawing of a workflow from node positions and connections (no React Flow). */
export function GraphPreview({ nodes, connections, colors = {} }: { nodes: WorkflowNode[]; connections: Connections; colors?: Record<string, string> }) {
  const shown = nodes.filter((n) => n.type !== 'flowforge.stickyNote');
  if (shown.length === 0) return null;
  const xs = shown.map((n) => n.position[0]);
  const ys = shown.map((n) => n.position[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(Math.max(...xs) - minX, 1);
  const spanY = Math.max(Math.max(...ys) - minY, 1);
  const vw = 320;
  const vh = 130;
  const pad = 18;
  // One scale keeps the proportions; a single row or column is centred.
  const scale = Math.min((vw - 2 * pad - W) / spanX, (vh - 2 * pad - H) / spanY, 0.45);
  const offX = (vw - (spanX * scale + W)) / 2;
  const offY = (vh - (spanY * scale + H)) / 2;
  const pos = new Map(shown.map((n) => [n.name, { x: offX + (n.position[0] - minX) * scale, y: offY + (n.position[1] - minY) * scale }]));

  const edges: Array<[string, string, boolean]> = [];
  for (const [from, byType] of Object.entries(connections)) {
    for (const [type, lists] of Object.entries(byType)) {
      for (const list of lists ?? []) for (const c of list ?? []) if (pos.has(from) && pos.has(c.node)) edges.push([from, c.node, type !== 'main']);
    }
  }

  return (
    <svg viewBox={`0 0 ${vw} ${vh}`} className="h-full w-full" role="img" aria-label="Workflow preview" data-testid="graph-preview">
      {edges.map(([a, b, ai], i) => {
        const p = pos.get(a)!;
        const q = pos.get(b)!;
        const x1 = p.x + W;
        const y1 = p.y + H / 2;
        const x2 = q.x;
        const y2 = q.y + H / 2;
        const dx = Math.max(Math.abs(x2 - x1) / 2, 8);
        return <path key={i} d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`} fill="none" stroke={ai ? '#8b5cf6' : '#6e6e7e'} strokeWidth={1.5} strokeDasharray={ai ? '3 3' : undefined} />;
      })}
      {shown.map((n) => {
        const p = pos.get(n.name)!;
        return (
          <g key={n.name}>
            <title>{n.name}</title>
            <rect x={p.x} y={p.y} width={W} height={H} rx={8} fill="#1f1f26" stroke={colors[n.type] ?? '#3b3b47'} strokeWidth={2} />
            <circle cx={p.x + W / 2} cy={p.y + H / 2} r={5} fill={colors[n.type] ?? '#6e6e7e'} />
          </g>
        );
      })}
    </svg>
  );
}
