import type { DB } from './index.js';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Ordered schema migrations. NEVER edit a migration after it has been committed:
 * add a new one instead. Timestamps are ISO-8601 strings (UTC).
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'users_sessions_settings',
    sql: `
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
        first_name    TEXT NOT NULL,
        last_name     TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'owner',
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE sessions (
        token_hash   TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        user_agent   TEXT
      );
      CREATE INDEX idx_sessions_user ON sessions(user_id);

      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: 'executions',
    sql: `
      CREATE TABLE executions (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id         TEXT,
        workflow_name       TEXT NOT NULL,
        mode                TEXT NOT NULL,
        status              TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        started_at          TEXT,
        stopped_at          TEXT,
        wait_till           TEXT,
        parent_execution_id INTEGER,
        retry_of            INTEGER,
        last_node           TEXT,
        error_message       TEXT
      );
      CREATE INDEX idx_executions_workflow ON executions(workflow_id, id DESC);
      CREATE INDEX idx_executions_status ON executions(status);

      CREATE TABLE execution_data (
        execution_id INTEGER PRIMARY KEY REFERENCES executions(id) ON DELETE CASCADE,
        workflow     TEXT NOT NULL,
        run_data     TEXT NOT NULL DEFAULT '{}',
        error        TEXT,
        events       TEXT NOT NULL DEFAULT '[]'
      );
    `,
  },
  {
    id: 3,
    name: 'workflows',
    sql: `
      CREATE TABLE workflows (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        active      INTEGER NOT NULL DEFAULT 0,
        nodes       TEXT NOT NULL DEFAULT '[]',
        connections TEXT NOT NULL DEFAULT '{}',
        settings    TEXT NOT NULL DEFAULT '{}',
        pin_data    TEXT NOT NULL DEFAULT '{}',
        version_id  TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX idx_workflows_updated ON workflows(updated_at DESC);
    `,
  },
  {
    id: 4,
    name: 'triggers_and_waiting',
    sql: `
      ALTER TABLE workflows ADD COLUMN static_data TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE workflows ADD COLUMN activation_error TEXT;
      ALTER TABLE workflows ADD COLUMN trigger_error TEXT;
      ALTER TABLE workflows ADD COLUMN trigger_error_at TEXT;
      ALTER TABLE executions ADD COLUMN waiting_node TEXT;
      ALTER TABLE executions ADD COLUMN wait_kind TEXT;
      ALTER TABLE executions ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE execution_data ADD COLUMN state TEXT;
      ALTER TABLE execution_data ADD COLUMN run_options TEXT;
      CREATE INDEX idx_executions_waiting ON executions(status, wait_till);
    `,
  },
  {
    id: 5,
    name: 'credentials',
    sql: `
      CREATE TABLE credentials (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL,
        data       TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_credentials_type ON credentials(type, created_at);
    `,
  },
  {
    id: 6,
    name: 'chat_memory',
    sql: `
      CREATE TABLE chat_memory (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX idx_chat_memory_session ON chat_memory(session_key, id);
    `,
  },
  {
    id: 7,
    name: 'tags',
    sql: `
      CREATE TABLE tags (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE workflow_tags (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (workflow_id, tag_id)
      );
      CREATE INDEX idx_workflow_tags_tag ON workflow_tags(tag_id);
    `,
  },
  {
    id: 8,
    name: 'workflow_versions',
    sql: `
      CREATE TABLE workflow_versions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        version_id  TEXT NOT NULL,
        number      INTEGER NOT NULL,
        name        TEXT NOT NULL,
        nodes       TEXT NOT NULL,
        connections TEXT NOT NULL,
        settings    TEXT NOT NULL DEFAULT '{}',
        hash        TEXT NOT NULL,
        source      TEXT NOT NULL DEFAULT 'save',
        note        TEXT,
        restored_from INTEGER,
        created_at  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_workflow_versions_number ON workflow_versions(workflow_id, number);
    `,
  },
  {
    id: 9,
    name: 'variables_and_execution_indexes',
    sql: `
      CREATE TABLE variables (
        id         TEXT PRIMARY KEY,
        key        TEXT NOT NULL UNIQUE,
        value      TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_executions_created ON executions(created_at);
      CREATE INDEX idx_executions_status_id ON executions(status, id DESC);
    `,
  },
];

export function runMigrations(db: DB, migrations: Migration[] = MIGRATIONS): number {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as { id: number }[]).map((row) => row.id),
  );
  const record = db.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)');
  let count = 0;
  for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.id, migration.name, new Date().toISOString());
    })();
    count++;
  }
  return count;
}
