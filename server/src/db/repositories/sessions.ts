import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../index.js';

/** Sessions are looked up by the SHA-256 of the cookie token, so a leaked DB does not leak live sessions. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionInfo {
  tokenHash: string;
  userId: string;
  expiresAt: string;
  lastSeenAt: string;
}

const TOUCH_INTERVAL_MS = 60_000;

export class SessionsRepo {
  constructor(private readonly db: DB) {}

  /** Creates a session and returns the raw token (only ever stored in the user's cookie). */
  create(userId: string, ttlMs: number, userAgent?: string): string {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hashToken(token),
        userId,
        now.toISOString(),
        new Date(now.getTime() + ttlMs).toISOString(),
        now.toISOString(),
        userAgent?.slice(0, 300) ?? null,
      );
    return token;
  }

  /** Returns the session if the token is valid and not expired; refreshes last_seen_at at most once a minute. */
  findValid(token: string): SessionInfo | undefined {
    const row = this.db
      .prepare(
        `SELECT token_hash AS tokenHash, user_id AS userId, expires_at AS expiresAt, last_seen_at AS lastSeenAt
         FROM sessions WHERE token_hash = ?`,
      )
      .get(hashToken(token)) as SessionInfo | undefined;
    if (!row) return undefined;
    const now = Date.now();
    if (Date.parse(row.expiresAt) <= now) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.tokenHash);
      return undefined;
    }
    if (now - Date.parse(row.lastSeenAt) > TOUCH_INTERVAL_MS) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date(now).toISOString(), row.tokenHash);
    }
    return row;
  }

  delete(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  deleteExpired(): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString()).changes;
  }
}
