import type { DB } from '../index.js';

/** Key/value store for instance settings (values are JSON). */
export class SettingsRepo {
  constructor(private readonly db: DB) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), new Date().toISOString());
  }
}
