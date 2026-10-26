import { randomUUID } from 'node:crypto';
import type { Variable } from '@flowforge/shared';
import type { DB } from '../index.js';

interface VariableRow {
  id: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

const toVariable = (r: VariableRow): Variable => ({ id: r.id, key: r.key, value: r.value, createdAt: r.created_at, updatedAt: r.updated_at });

/** Global variables for $vars (table variables) — owner: W4. Contract: docs/phase7-contracts.md */
export class VariablesRepo {
  constructor(protected readonly db: DB) {}

  list(): Variable[] {
    return (this.db.prepare('SELECT * FROM variables ORDER BY key COLLATE NOCASE').all() as VariableRow[]).map(toVariable);
  }

  get(id: string): Variable | undefined {
    const r = this.db.prepare('SELECT * FROM variables WHERE id = ?').get(id) as VariableRow | undefined;
    return r && toVariable(r);
  }

  findByKey(key: string): Variable | undefined {
    const r = this.db.prepare('SELECT * FROM variables WHERE key = ?').get(key) as VariableRow | undefined;
    return r && toVariable(r);
  }

  /** What `$vars` sees. */
  asRecord(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.db.prepare('SELECT key, value FROM variables').all() as Array<{ key: string; value: string }>) out[r.key] = r.value;
    return out;
  }

  create(key: string, value: string): Variable {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO variables (id, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, key, value, now, now);
    return this.get(id)!;
  }

  update(id: string, patch: { key?: string; value?: string }): Variable | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    this.db
      .prepare('UPDATE variables SET key = ?, value = ?, updated_at = ? WHERE id = ?')
      .run(patch.key ?? current.key, patch.value ?? current.value, new Date().toISOString(), id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM variables WHERE id = ?').run(id).changes > 0;
  }
}
