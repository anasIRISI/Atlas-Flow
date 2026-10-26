import { openSqlite, type DB } from './driver.js';
import { runMigrations } from './migrations.js';

export type { DB } from './driver.js';

/** Opens (or creates) the SQLite database and applies pending migrations. Use ':memory:' in tests. */
export function openDatabase(file: string): DB {
  const db = openSqlite(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  runMigrations(db);
  return db;
}
