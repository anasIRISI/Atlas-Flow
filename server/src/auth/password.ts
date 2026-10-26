import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt is built into Node: no native add-on to compile, unlike bcrypt.
const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 64;

function scrypt(password: string, salt: Buffer, keyLen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, keyLen, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Format: scrypt$N$r$p$<salt base64>$<hash base64> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A valid hash of a random password, used to keep login timing constant for unknown emails. */
export const DUMMY_HASH_PROMISE = hashPassword(randomBytes(16).toString('hex'));
