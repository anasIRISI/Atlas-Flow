import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('Forge2026');
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword('Forge2026', hash)).toBe(true);
    expect(await verifyPassword('forge2026', hash)).toBe(false);
  });

  it('uses a random salt', async () => {
    expect(await hashPassword('Same1Pass')).not.toBe(await hashPassword('Same1Pass'));
  });

  it('rejects malformed hashes without throwing', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$1$2$3$4$5')).toBe(false);
  });
});
