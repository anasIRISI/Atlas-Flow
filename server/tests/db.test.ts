import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { MIGRATIONS, runMigrations } from '../src/db/migrations.js';
import { SessionsRepo } from '../src/db/repositories/sessions.js';
import { UsersRepo } from '../src/db/repositories/users.js';

describe('migrations', () => {
  it('creates the schema and is idempotent', () => {
    const db = openDatabase(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (t) => t.name,
    );
    expect(tables).toEqual(expect.arrayContaining(['_migrations', 'users', 'sessions', 'settings']));
    expect(runMigrations(db)).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n).toBe(MIGRATIONS.length);
  });

  it('rolls back a failing migration completely', () => {
    const db = openDatabase(':memory:');
    const bad = [{ id: 999, name: 'broken', sql: 'CREATE TABLE half_done (id INTEGER); SELECT * FROM missing_table;' }];
    expect(() => runMigrations(db, bad)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='half_done'").get()).toBeUndefined();
    expect(db.prepare('SELECT id FROM _migrations WHERE id = 999').get()).toBeUndefined();
  });
});

describe('users + sessions repositories', () => {
  it('creates only one owner and finds users case-insensitively', () => {
    const users = new UsersRepo(openDatabase(':memory:'));
    const owner = users.createOwnerIfNone({ email: 'A@B.co', firstName: 'A', lastName: '', passwordHash: 'x' });
    expect(owner?.role).toBe('owner');
    expect(users.createOwnerIfNone({ email: 'c@d.co', firstName: 'C', lastName: '', passwordHash: 'x' })).toBeUndefined();
    expect(users.findByEmail('a@b.CO')?.id).toBe(owner?.id);
  });

  it('expires sessions and cascades on user deletion', () => {
    const db = openDatabase(':memory:');
    const users = new UsersRepo(db);
    const sessions = new SessionsRepo(db);
    const user = users.createOwnerIfNone({ email: 'a@b.co', firstName: 'A', lastName: '', passwordHash: 'x' })!;
    const live = sessions.create(user.id, 60_000);
    const dead = sessions.create(user.id, -1);
    expect(sessions.findValid(live)?.userId).toBe(user.id);
    expect(sessions.findValid(dead)).toBeUndefined();
    expect(sessions.findValid('not-a-token')).toBeUndefined();
    // The raw token is never stored.
    expect(db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(live)).toBeUndefined();
    users.deleteAll();
    expect(sessions.findValid(live)).toBeUndefined();
  });
});
