import { createHash, randomUUID } from 'node:crypto';
import { diffWorkflows, stableStringify } from '@flowforge/shared';
import type {
  Connections,
  VersionSource,
  WorkflowNode,
  WorkflowRecord,
  WorkflowSettings,
  WorkflowVersionDetail,
  WorkflowVersionSummary,
} from '@flowforge/shared';
import type { DB } from '../index.js';

export const MAX_VERSIONS = 100;

interface Row {
  id: number;
  workflow_id: string;
  number: number;
  name: string;
  nodes: string;
  connections: string;
  settings: string;
  source: string;
  note: string | null;
  restored_from: number | null;
  created_at: string;
}

const snapshot = (r: Row) => ({
  name: r.name,
  nodes: JSON.parse(r.nodes) as WorkflowNode[],
  connections: JSON.parse(r.connections) as Connections,
  settings: JSON.parse(r.settings) as WorkflowSettings,
});

function summary(r: Row, prev: Row | undefined): WorkflowVersionSummary {
  const snap = snapshot(r);
  return {
    id: String(r.id),
    workflowId: r.workflow_id,
    number: r.number,
    name: r.name,
    source: r.source as VersionSource,
    note: r.note,
    restoredFrom: r.restored_from,
    nodeCount: snap.nodes.filter((n) => n.type !== 'flowforge.stickyNote').length,
    createdAt: r.created_at,
    diff: diffWorkflows(prev ? snapshot(prev) : null, snap),
  };
}

/**
 * Workflow version history (table workflow_versions). Contract: docs/phase7-contracts.md
 * The hash covers name, nodes, connections and settings (positions included, pinData excluded).
 * A rename through PATCH /api/workflows/:id does NOT record a version; the next save does (the name is part of the hash).
 */
export class VersionsRepo {
  constructor(protected readonly db: DB) {}

  static hash(wf: { name: string; nodes: unknown; connections: unknown; settings?: unknown }): string {
    return createHash('sha256').update(stableStringify({ name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings ?? {} })).digest('hex');
  }

  /** Stores a snapshot unless identical to the latest version. Returns the new number, or null when nothing changed. */
  record(wf: WorkflowRecord, options: { source: VersionSource; note?: string | null; restoredFrom?: number | null }): number | null {
    const hash = VersionsRepo.hash(wf);
    const last = this.db.prepare('SELECT number, hash FROM workflow_versions WHERE workflow_id = ? ORDER BY number DESC LIMIT 1').get(wf.id) as
      | { number: number; hash: string }
      | undefined;
    if (last && last.hash === hash) {
      return null;
    }
    const number = (last?.number ?? 0) + 1;
    const note = options.note?.trim().slice(0, 200) || null;
    this.db
      .prepare(
        `INSERT INTO workflow_versions (workflow_id, version_id, number, name, nodes, connections, settings, hash, source, note, restored_from, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        wf.id,
        randomUUID(),
        number,
        wf.name,
        JSON.stringify(wf.nodes),
        JSON.stringify(wf.connections),
        JSON.stringify(wf.settings ?? {}),
        hash,
        options.source,
        note,
        options.restoredFrom ?? null,
        new Date().toISOString(),
      );
    this.db
      .prepare('DELETE FROM workflow_versions WHERE workflow_id = ? AND number <= ?')
      .run(wf.id, number - MAX_VERSIONS);
    return number;
  }

  /** Newest first, each with its diff against the previous version. */
  list(workflowId: string): WorkflowVersionSummary[] {
    const rows = this.db.prepare('SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY number ASC').all(workflowId) as Row[];
    return rows.map((r, i) => summary(r, rows[i - 1])).reverse();
  }

  get(workflowId: string, number: number): WorkflowVersionDetail | undefined {
    const row = this.db.prepare('SELECT * FROM workflow_versions WHERE workflow_id = ? AND number = ?').get(workflowId, number) as Row | undefined;
    if (!row) return undefined;
    const prev = this.db.prepare('SELECT * FROM workflow_versions WHERE workflow_id = ? AND number < ? ORDER BY number DESC LIMIT 1').get(workflowId, number) as
      | Row
      | undefined;
    const snap = snapshot(row);
    return { ...summary(row, prev), nodes: snap.nodes, connections: snap.connections, settings: snap.settings };
  }

  setNote(workflowId: string, number: number, note: string | null): boolean {
    return this.db.prepare('UPDATE workflow_versions SET note = ? WHERE workflow_id = ? AND number = ?').run(note, workflowId, number).changes > 0;
  }
}
