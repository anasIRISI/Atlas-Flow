import { tooManyRequests } from './errors.js';

/** Tiny in-memory limiter for failed attempts (login/setup brute force). */
export class FailureLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
  ) {}

  /** Throws 429 if the key is currently blocked. */
  check(key: string): void {
    const entry = this.attempts.get(key);
    if (!entry) return;
    if (entry.resetAt <= Date.now()) {
      this.attempts.delete(key);
      return;
    }
    if (entry.count >= this.maxFailures) {
      const minutes = Math.ceil((entry.resetAt - Date.now()) / 60_000);
      throw tooManyRequests(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }
  }

  fail(key: string): void {
    const now = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt <= now) this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count++;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}
