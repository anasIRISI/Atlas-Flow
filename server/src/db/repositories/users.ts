import { randomUUID } from 'node:crypto';
import type { PublicUser, UserRole } from '@flowforge/shared';
import type { DB } from '../index.js';

interface UserRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  password_hash: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

export interface UserWithHash extends PublicUser {
  passwordHash: string;
}

function fromRow(row: UserRow): UserWithHash {
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    createdAt: row.created_at,
    passwordHash: row.password_hash,
  };
}

export function toPublicUser(user: UserWithHash): PublicUser {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

export class UsersRepo {
  constructor(private readonly db: DB) {}

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  findById(id: string): UserWithHash | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row && fromRow(row);
  }

  findByEmail(email: string): UserWithHash | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) as UserRow | undefined;
    return row && fromRow(row);
  }

  create(input: { email: string; firstName: string; lastName: string; passwordHash: string; role: UserRole }) {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO users (id, email, first_name, last_name, password_hash, role, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.email.trim(), input.firstName.trim(), input.lastName.trim(), input.passwordHash, input.role, now, now);
    return this.findById(id)!;
  }

  /** Creates the owner only if no user exists yet (atomic, so two parallel setups cannot both succeed). */
  createOwnerIfNone(input: { email: string; firstName: string; lastName: string; passwordHash: string }) {
    return this.db.transaction(() => (this.count() > 0 ? undefined : this.create({ ...input, role: 'owner' })))();
  }

  deleteAll(): number {
    return this.db.prepare('DELETE FROM users').run().changes;
  }
}
