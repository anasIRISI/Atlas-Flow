import type { WorkflowData, WorkflowNode } from '@flowforge/shared';
import { WorkflowOperationError } from './errors.js';

/** Fast lookups over a workflow's nodes and main connections. */
export class WorkflowGraph {
  readonly nodes = new Map<string, WorkflowNode>();
  private readonly parentsOf = new Map<string, Set<string>>();

  constructor(readonly workflow: WorkflowData) {
    for (const node of workflow.nodes) {
      if (this.nodes.has(node.name)) {
        throw new WorkflowOperationError(`Two nodes are named "${node.name}"`, { hint: 'Node names must be unique. Rename one of them.' });
      }
      this.nodes.set(node.name, node);
    }
    for (const [from, byType] of Object.entries(workflow.connections ?? {})) {
      if (!this.nodes.has(from)) {
        throw new WorkflowOperationError(`A connection starts at node "${from}", which doesn't exist`);
      }
      for (const output of byType.main ?? []) {
        for (const target of output ?? []) {
          if (!this.nodes.has(target.node)) {
            throw new WorkflowOperationError(`Node "${from}" is connected to "${target.node}", which doesn't exist`);
          }
          if (!this.parentsOf.has(target.node)) this.parentsOf.set(target.node, new Set());
          this.parentsOf.get(target.node)!.add(from);
        }
      }
    }
  }

  node(name: string): WorkflowNode {
    const node = this.nodes.get(name);
    if (!node) throw new WorkflowOperationError(`Node "${name}" doesn't exist in this workflow`);
    return node;
  }

  parents(name: string): string[] {
    return [...(this.parentsOf.get(name) ?? [])];
  }

  /** The node itself plus every node it depends on (through main connections). */
  ancestorsOf(name: string): Set<string> {
    const seen = new Set<string>([name]);
    const queue = [name];
    while (queue.length) {
      for (const parent of this.parents(queue.pop()!)) {
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return seen;
  }

  /** Sort key: top-to-bottom, then left-to-right (n8n v1 branch order). */
  position(name: string): [number, number] {
    const [x, y] = this.nodes.get(name)?.position ?? [0, 0];
    return [y, x];
  }
}
