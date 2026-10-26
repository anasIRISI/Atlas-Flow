import { randomUUID } from 'node:crypto';
import type { Tag } from '@flowforge/shared';
import type { DB } from '../index.js';

interface TagRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  usage_count?: number;
}

const toTag = (r: TagRow): Tag => ({
  id: r.id,
  name: r.name,
  ...(r.usage_count === undefined ? {} : { usageCount: r.usage_count }),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Tags and workflow ↔ tag links (tables tags, workflow_tags) — owner: W1. Contract: docs/phase7-contracts.md */
export class TagsRepo {
  constructor(protected readonly db: DB) {}

  list(): Tag[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM workflow_tags wt WHERE wt.tag_id = t.id) AS usage_count
         FROM tags t ORDER BY t.name COLLATE NOCASE`,
      )
      .all() as TagRow[];
    return rows.map(toTag);
  }

  get(id: string): Tag | undefined {
    const r = this.db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow | undefined;
    return r && toTag(r);
  }

  findByName(name: string): Tag | undefined {
    const r = this.db.prepare('SELECT * FROM tags WHERE name = ? COLLATE NOCASE').get(name) as TagRow | undefined;
    return r && toTag(r);
  }

  create(name: string): Tag {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO tags (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, name, now, now);
    return this.get(id)!;
  }

  rename(id: string, name: string): Tag | undefined {
    const res = this.db.prepare('UPDATE tags SET name = ?, updated_at = ? WHERE id = ?').run(name, new Date().toISOString(), id);
    return res.changes ? this.get(id) : undefined;
  }

  delete(id: string): boolean {
    this.db.prepare('DELETE FROM workflow_tags WHERE tag_id = ?').run(id);
    return this.db.prepare('DELETE FROM tags WHERE id = ?').run(id).changes > 0;
  }

  forWorkflow(workflowId: string): Array<{ id: string; name: string }> {
    return this.db
      .prepare('SELECT t.id, t.name FROM tags t JOIN workflow_tags wt ON wt.tag_id = t.id WHERE wt.workflow_id = ? ORDER BY t.name COLLATE NOCASE')
      .all(workflowId) as Array<{ id: string; name: string }>;
  }

  /** Replaces the tags of a workflow. */
  setForWorkflow(workflowId: string, tagIds: string[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM workflow_tags WHERE workflow_id = ?').run(workflowId);
      const ins = this.db.prepare('INSERT OR IGNORE INTO workflow_tags (workflow_id, tag_id) VALUES (?, ?)');
      for (const id of tagIds) ins.run(workflowId, id);
    })();
  }

  /** Existing tag with that name or a new one. */
  ensure(name: string): Tag {
    return this.findByName(name) ?? this.create(name);
  }
}
