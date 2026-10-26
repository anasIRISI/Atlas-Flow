import type { DB } from '../index.js';

/** A stored credential. `data` is the AES-256-GCM payload: never decrypted here. */
export interface CredentialRow {
  id: string;
  name: string;
  type: string;
  data: string;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export class CredentialsRepo {
  constructor(private readonly db: DB) {}

  list(type?: string): CredentialRow[] {
    return (
      type
        ? this.db.prepare('SELECT * FROM credentials WHERE type = ? ORDER BY created_at, id').all(type)
        : this.db.prepare('SELECT * FROM credentials ORDER BY type, created_at, id').all()
    ) as CredentialRow[];
  }

  get(id: string): CredentialRow | undefined {
    return this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as CredentialRow | undefined;
  }

  findByName(type: string, name: string): CredentialRow | undefined {
    return this.db.prepare('SELECT * FROM credentials WHERE type = ? AND name = ? ORDER BY created_at LIMIT 1').get(type, name) as CredentialRow | undefined;
  }

  defaultFor(type: string): CredentialRow | undefined {
    return this.db.prepare('SELECT * FROM credentials WHERE type = ? AND is_default = 1 LIMIT 1').get(type) as CredentialRow | undefined;
  }

  /** Inserts a row; the first credential of a type becomes its default. */
  insert(row: Omit<CredentialRow, 'is_default' | 'created_at' | 'updated_at'>, makeDefault: boolean): CredentialRow {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const first = !this.defaultFor(row.type);
      if (makeDefault) this.db.prepare('UPDATE credentials SET is_default = 0 WHERE type = ?').run(row.type);
      this.db
        .prepare('INSERT INTO credentials (id, name, type, data, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, row.name, row.type, row.data, makeDefault || first ? 1 : 0, now, now);
    })();
    return this.get(row.id)!;
  }

  update(id: string, patch: { name?: string; data?: string }): void {
    const current = this.get(id);
    if (!current) return;
    this.db
      .prepare('UPDATE credentials SET name = ?, data = ?, updated_at = ? WHERE id = ?')
      .run(patch.name ?? current.name, patch.data ?? current.data, new Date().toISOString(), id);
  }

  setDefault(id: string, isDefault: boolean): void {
    const current = this.get(id);
    if (!current) return;
    this.db.transaction(() => {
      if (isDefault) this.db.prepare('UPDATE credentials SET is_default = 0 WHERE type = ?').run(current.type);
      this.db.prepare('UPDATE credentials SET is_default = ? WHERE id = ?').run(isDefault ? 1 : 0, id);
    })();
  }

  /** Deletes; when the default is deleted, the oldest remaining credential of that type takes over. */
  delete(id: string): boolean {
    const current = this.get(id);
    if (!current) return false;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
      if (current.is_default === 1) {
        const next = this.db.prepare('SELECT id FROM credentials WHERE type = ? ORDER BY created_at, id LIMIT 1').get(current.type) as { id: string } | undefined;
        if (next) this.db.prepare('UPDATE credentials SET is_default = 1 WHERE id = ?').run(next.id);
      }
    })();
    return true;
  }
}
