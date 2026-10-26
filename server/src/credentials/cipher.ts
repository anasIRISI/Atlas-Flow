import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CredentialDecryptError extends Error {}

/**
 * Key for credential encryption: FLOWFORGE_ENCRYPTION_KEY (64 hex chars, or any passphrase hashed with SHA-256),
 * otherwise `data/.encryption_key`, generated on first use. Losing the key makes saved credentials unreadable.
 */
export function loadEncryptionKey(dataDir: string, fromEnv?: string): Buffer {
  if (fromEnv?.trim()) {
    const value = fromEnv.trim();
    return /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : createHash('sha256').update(value).digest();
  }
  const file = join(dataDir, '.encryption_key');
  if (existsSync(file)) {
    const hex = readFileSync(file, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new Error(`${file} is not a valid encryption key (expected 64 hex characters). Restore it from a backup.`);
    }
    return Buffer.from(hex, 'hex');
  }
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, `${key.toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  return key;
}

/** AES-256-GCM. Each value gets a random IV; the credential id is bound as additional data. */
export class CredentialCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('The credential encryption key must be 32 bytes');
  }

  encrypt(plain: string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
  }

  decrypt(payload: string, aad: string): string {
    const [version, data] = payload.split(':');
    if (version !== VERSION || !data) throw new CredentialDecryptError('Unknown credential format');
    const raw = Buffer.from(data, 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) throw new CredentialDecryptError('Credential data is truncated');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV_BYTES));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch {
      throw new CredentialDecryptError(
        'This credential cannot be decrypted: the encryption key changed (data/.encryption_key or FLOWFORGE_ENCRYPTION_KEY). Enter its values again.',
      );
    }
  }
}
