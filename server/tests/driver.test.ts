import { describe, expect, it } from 'vitest';
import { openSqlite, type DB } from '../src/db/driver.js';

/** Drivers that can actually be loaded on this Node version (better-sqlite3 on 20/22/24, node:sqlite on 22.13+). */
const available = (['better-sqlite3', 'node'] as const).filter((name) => {
  try {
    openSqlite(':memory:', name).close();
    return true;
  } catch {
    return false;
  }
});

it('has at least one working SQLite driver', () => {
  expect(available.length).toBeGreaterThan(0);
});

it('prefers better-sqlite3 and falls back automatically', () => {
  const db = openSqlite(':memory:', undefined);
  expect(db.driver).toBe(available.includes('better-sqlite3') ? 'better-sqlite3' : 'node:sqlite');
  db.close();
});

describe.each(available)('driver %s', (name) => {
  const open = (): DB => {
    const db = openSqlite(':memory:', name);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    return db;
  };
  const names = (db: DB) => (db.prepare('SELECT name FROM t ORDER BY id').all() as { name: string }[]).map((r) => r.name);

  it('prepares, runs and reads', () => {
    const db = open();
    const result = db.prepare('INSERT INTO t (name) VALUES (?)').run('a');
    expect(result.changes).toBe(1);
    expect(Number(result.lastInsertRowid)).toBe(1);
    expect(db.prepare('SELECT * FROM t WHERE id = ?').get(1)).toEqual({ id: 1, name: 'a' });
    expect(db.prepare('SELECT * FROM t WHERE id = ?').get(99)).toBeUndefined();
  });

  it('commits and rolls back transactions', () => {
    const db = open();
    const insert = db.prepare('INSERT INTO t (name) VALUES (?)');
    expect(db.transaction((n: string) => insert.run(n).changes)('kept')).toBe(1);
    expect(() =>
      db.transaction(() => {
        insert.run('lost');
        throw new Error('boom');
      })(),
    ).toThrow('boom');
    expect(names(db)).toEqual(['kept']);
  });

  it('supports nested transactions (inner failure only undoes the inner part)', () => {
    const db = open();
    const insert = db.prepare('INSERT INTO t (name) VALUES (?)');
    db.transaction(() => {
      insert.run('outer');
      try {
        db.transaction(() => {
          insert.run('inner');
          throw new Error('inner fails');
        })();
      } catch {
        /* expected */
      }
      insert.run('after');
    })();
    expect(names(db)).toEqual(['outer', 'after']);
  });

  it('applies pragmas', () => {
    const db = open();
    db.pragma('foreign_keys = ON');
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });
});
