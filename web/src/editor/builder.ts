import { BUILDER_SUGGESTIONS, type BuildWorkflowResponse, type Connections, type WorkflowNode } from '@flowforge/shared';
import { buildWorkflow } from '../lib/ai-api';
import { addEdge, autoLayout, edgeKey, listAllEdges } from './graph';
import { editor } from './store';

/** Six ready prompts shown as chips under the builder bar (each one also works offline). */
export const SUGGESTIONS: readonly string[] = BUILDER_SUGGESTIONS;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Replaces the canvas by the built workflow, drawing it step by step: each node pops in (in `order`), and an
 * edge is drawn as soon as both of its ends exist. All the steps are one undo step.
 */
export async function drawWorkflow(result: BuildWorkflowResponse, fit: () => void): Promise<void> {
  const { connections, name } = result.workflow;
  // The editor's own layout knows the real sizes of the cards (wide cluster nodes, small sub-nodes).
  const positions = autoLayout(result.workflow.nodes, connections, (n) => n.type === 'flowforge.stickyNote');
  const nodes = result.workflow.nodes.map((n) => ({ ...n, position: positions.get(n.name) ?? n.position }));
  const edges = listAllEdges(connections);
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const order = [...result.order.filter((n) => byName.has(n)), ...nodes.map((n) => n.name).filter((n) => !result.order.includes(n))];
  // About 2.5 s for the whole drawing, never slower than 320 ms per node.
  const pause = Math.max(110, Math.min(320, Math.round(2500 / Math.max(1, order.length))));

  editor.setMissingCredentials({});
  editor.buildStep({ nodes: [], connections: {}, pinData: {}, name });
  let placed: WorkflowNode[] = [];
  let drawn: Connections = {};
  const seen = new Set<string>();
  const fresh: string[] = [];
  for (const nodeName of order) {
    placed = [...placed, byName.get(nodeName)!];
    seen.add(nodeName);
    const ready = edges.filter((e) => seen.has(e.source) && seen.has(e.target) && !fresh.includes(edgeKey(e)));
    for (const e of ready) drawn = addEdge(drawn, e);
    const added = [nodeName, ...ready.map(edgeKey)];
    fresh.push(...added);
    editor.buildStep({ nodes: placed, connections: drawn }, added);
    requestAnimationFrame(fit);
    await sleep(pause);
  }
  const missing: Record<string, string[]> = {};
  for (const m of result.missingCredentials) (missing[m.node] ??= []).push(m.displayName);
  editor.setMissingCredentials(missing);
  setTimeout(() => editor.settle(fresh), 800);
}

export async function buildWithAi(prompt: string, fit: () => void): Promise<BuildWorkflowResponse> {
  const result = await buildWorkflow(prompt);
  await drawWorkflow(result, fit);
  return result;
}
