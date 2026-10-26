import { randomUUID } from 'node:crypto';
import type { Connections, ExecutionStatus, Item, WorkflowData, WorkflowNode, WorkflowRecord, WorkflowSettings, WorkflowSummary } from '@flowforge/shared';
import type { DB } from '../index.js';

interface Row {
  id: string;
  name: string;
  active: number;
  nodes: string;
  connections: string;
  settings: string;
  pin_data: string;
  version_id: string;
  created_at: string;
  updated_at: string;
  activation_error: string | null;
  trigger_error: string | null;
  trigger_error_at: string | null;
}

export interface WorkflowInput {
  name: string;
  nodes?: WorkflowNode[];
  connections?: Connections;
  settings?: WorkflowSettings;
  pinData?: Record<string, Item[]>;
}

function toRecord(row: Row): WorkflowRecord {
  return {
    id: row.id,
    name: row.name,
    active: row.active === 1,
    nodes: JSON.parse(row.nodes) as WorkflowNode[],
    connections: JSON.parse(row.connections) as Connections,
    settings: JSON.parse(row.settings) as WorkflowSettings,
    pinData: JSON.parse(row.pin_data) as Record<string, Item[]>,
    versionId: row.version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activationError: row.activation_error,
    triggerError: row.trigger_error,
    triggerErrorAt: row.trigger_error_at,
  };
}

export class WorkflowsRepo {
  constructor(private readonly db: DB) {}

  list(): WorkflowSummary[] {
    // One query for the rows, one for all tags, one for the latest execution of every workflow (no N+1).
    const rows = this.db
      .prepare('SELECT id, name, active, nodes, created_at, updated_at, activation_error, trigger_error, trigger_error_at FROM workflows ORDER BY updated_at DESC')
      .all() as Row[];
    const tagRows = this.db
      .prepare('SELECT wt.workflow_id AS wid, t.id AS id, t.name AS name FROM workflow_tags wt JOIN tags t ON t.id = wt.tag_id ORDER BY t.name COLLATE NOCASE')
      .all() as Array<{ wid: string; id: string; name: string }>;
    const tagsBy = new Map<string, Array<{ id: string; name: string }>>();
    for (const t of tagRows) {
      const list = tagsBy.get(t.wid) ?? [];
      list.push({ id: t.id, name: t.name });
      tagsBy.set(t.wid, list);
    }
    const lastRows = this.db
      .prepare(
        `SELECT e.workflow_id AS wid, e.status AS status, COALESCE(e.started_at, e.created_at) AS at
         FROM executions e
         WHERE e.workflow_id IS NOT NULL AND e.id = (SELECT MAX(x.id) FROM executions x WHERE x.workflow_id = e.workflow_id)`,
      )
      .all() as Array<{ wid: string; status: ExecutionStatus; at: string }>;
    const lastBy = new Map(lastRows.map((r) => [r.wid, r]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      active: r.active === 1,
      nodeCount: (JSON.parse(r.nodes) as WorkflowNode[]).filter((n) => n.type !== 'flowforge.stickyNote').length,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      activationError: r.activation_error,
      triggerError: r.trigger_error,
      triggerErrorAt: r.trigger_error_at,
      tags: tagsBy.get(r.id) ?? [],
      lastExecutionStatus: lastBy.get(r.id)?.status ?? null,
      lastExecutionAt: lastBy.get(r.id)?.at ?? null,
    }));
  }

  get(id: string): WorkflowRecord | undefined {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Row | undefined;
    return row && toRecord(row);
  }

  /** "My workflow", "My workflow 2", … */
  uniqueName(base: string): string {
    const names = new Set((this.db.prepare('SELECT name FROM workflows').all() as { name: string }[]).map((r) => r.name));
    if (!names.has(base)) return base;
    let n = 2;
    while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  create(input: WorkflowInput): WorkflowRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workflows (id, name, nodes, connections, settings, pin_data, version_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        JSON.stringify(input.nodes ?? []),
        JSON.stringify(input.connections ?? {}),
        JSON.stringify(input.settings ?? {}),
        JSON.stringify(input.pinData ?? {}),
        randomUUID(),
        now,
        now,
      );
    return this.get(id)!;
  }

  /** Full replace. Returns undefined if the workflow does not exist. */
  update(id: string, input: WorkflowInput): WorkflowRecord | undefined {
    const result = this.db
      .prepare(
        `UPDATE workflows SET name = ?, nodes = ?, connections = ?, settings = ?, pin_data = ?, version_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name,
        JSON.stringify(input.nodes ?? []),
        JSON.stringify(input.connections ?? {}),
        JSON.stringify(input.settings ?? {}),
        JSON.stringify(input.pinData ?? {}),
        randomUUID(),
        new Date().toISOString(),
        id,
      );
    return result.changes ? this.get(id) : undefined;
  }

  rename(id: string, name: string): WorkflowRecord | undefined {
    const result = this.db
      .prepare('UPDATE workflows SET name = ?, version_id = ?, updated_at = ? WHERE id = ?')
      .run(name, randomUUID(), new Date().toISOString(), id);
    return result.changes ? this.get(id) : undefined;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id).changes > 0;
  }

  /** For runs: the stored workflow as plain WorkflowData. */
  toWorkflowData(record: WorkflowRecord): WorkflowData {
    const { versionId: _v, createdAt: _c, updatedAt: _u, activationError: _a, triggerError: _t, triggerErrorAt: _ta, ...data } = record;
    return data;
  }

  listActiveIds(): string[] {
    return (this.db.prepare('SELECT id FROM workflows WHERE active = 1').all() as { id: string }[]).map((r) => r.id);
  }

  /** Marks the workflow (in)active; activating clears old errors. */
  setActive(id: string, active: boolean): void {
    this.db
      .prepare(
        active
          ? 'UPDATE workflows SET active = 1, activation_error = NULL, trigger_error = NULL, trigger_error_at = NULL WHERE id = ?'
          : 'UPDATE workflows SET active = 0, trigger_error = NULL, trigger_error_at = NULL WHERE id = ?',
      )
      .run(id);
  }

  setActivationError(id: string, message: string | null): void {
    this.db.prepare('UPDATE workflows SET activation_error = ? WHERE id = ?').run(message, id);
  }

  setTriggerError(id: string, message: string | null): void {
    this.db.prepare('UPDATE workflows SET trigger_error = ?, trigger_error_at = ? WHERE id = ?').run(message, message ? new Date().toISOString() : null, id);
  }

  getStaticData(id: string): Record<string, Record<string, unknown>> {
    const row = this.db.prepare('SELECT static_data FROM workflows WHERE id = ?').get(id) as { static_data: string } | undefined;
    return row ? (JSON.parse(row.static_data) as Record<string, Record<string, unknown>>) : {};
  }

  setStaticData(id: string, data: Record<string, Record<string, unknown>>): void {
    this.db.prepare('UPDATE workflows SET static_data = ? WHERE id = ?').run(JSON.stringify(data), id);
  }
}
