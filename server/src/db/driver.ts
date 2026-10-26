import { createRequire } from 'node:module';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * SQLite access goes through this tiny interface so FlowForge runs on every Node version:
 *  - better-sqlite3 (preferred, prebuilt binaries for Node 20 / 22 / 24),
 *  - Node's built-in `node:sqlite` as automatic fallback (Node ≥ 22.13), e.g. on Node 26 where
 *    better-sqlite3 12.9.0 has no prebuilt binary and no C++ compiler is installed.
 * Force one with FLOWFORGE_SQLITE_DRIVER=better-sqlite3 | node (used by tests).
 */
export type DriverName = 'better-sqlite3' | 'node:sqlite';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
}

export interface DB {
  readonly driver: DriverName;
  prepare(sql: string): Statement;
  exec(sql: string): void;
  /** Wraps `fn` in a transaction (nested calls use savepoints). Same semantics as better-sqlite3. */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
  /** Runs `PRAGMA <pragma>`. */
  pragma(pragma: string): void;
  close(): void;
}

const require = createRequire(import.meta.url);

// ── better-sqlite3 ──────────────────────────────────────────────────────────

function openBetterSqlite(file: string): DB {
  const Database = require('better-sqlite3') as typeof BetterSqlite3;
  const db = new Database(file);
  return {
    driver: 'better-sqlite3',
    prepare: (sql) => db.prepare(sql) as unknown as Statement,
    exec: (sql) => void db.exec(sql),
    transaction: (fn) => db.transaction(fn) as never,
    pragma: (pragma) => void db.pragma(pragma),
    close: () => db.close(),
  };
}

// ── node:sqlite ─────────────────────────────────────────────────────────────

interface NodeSqliteModule {
  DatabaseSync: new (file: string) => {
    prepare(sql: string): Statement;
    exec(sql: string): void;
    close(): void;
  };
}

function loadNodeSqlite(): NodeSqliteModule {
  // node:sqlite prints an "experimental" warning on some Node versions; it is expected, so hide it.
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (/sqlite/i.test(text)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return require('node:sqlite') as NodeSqliteModule;
  } finally {
    process.emitWarning = original;
  }
}

function openNodeSqlite(file: string): DB {
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(file);
  let depth = 0;
  return {
    driver: 'node:sqlite',
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    transaction:
      (fn) =>
      (...args) => {
        const savepoint = `ff_sp_${depth}`;
        db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
        depth++;
        try {
          const result = fn(...args);
          depth--;
          db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
          return result;
        } catch (err) {
          depth--;
          db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
          throw err;
        }
      },
    pragma: (pragma) => db.exec(`PRAGMA ${pragma}`),
    close: () => db.close(),
  };
}

// ── selection ───────────────────────────────────────────────────────────────

function describe(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0]! : String(err);
}

/** Opens the database with the best available driver, or throws an error that says how to fix it. */
export function openSqlite(file: string, forced = process.env.FLOWFORGE_SQLITE_DRIVER): DB {
  if (forced === 'node') return openNodeSqlite(file);
  if (forced === 'better-sqlite3') return openBetterSqlite(file);

  let betterError: unknown;
  try {
    return openBetterSqlite(file);
  } catch (err) {
    betterError = err;
  }
  try {
    return openNodeSqlite(file);
  } catch (nodeError) {
    throw new Error(
      `No SQLite driver could be loaded on Node.js ${process.versions.node}.\n` +
        `  • better-sqlite3: ${describe(betterError)}\n` +
        `  • node:sqlite (built into Node 22.13+): ${describe(nodeError)}\n` +
        '  Fix: run `npm install` again with a working internet connection (it downloads a prebuilt\n' +
        '  better-sqlite3 binary from github.com), or switch to Node.js 22 or 24 LTS.',
    );
  }
}
