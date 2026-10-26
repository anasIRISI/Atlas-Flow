// `npm run check [-- --send]`
// One real call per integration with the saved credentials (or .env): prints OK / FAIL (reason) / SKIP (what to set
// where) and exits with code 1 when something failed. Secrets are never printed.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowNode } from '@flowforge/shared';
import { loadConfig, loadDotEnv } from '../config.js';
import { CredentialCipher, loadEncryptionKey } from '../credentials/cipher.js';
import { completeData, CredentialTypeRegistry, fromEnv } from '../credentials/registry.js';
import { CredentialsService } from '../credentials/service.js';
import { openDatabase } from '../db/index.js';
import { CredentialsRepo } from '../db/repositories/credentials.js';
import { MissingCredentialError } from '../engine/errors.js';
import type { ResolvedCredential } from '../engine/types.js';
import { silentLogger } from '../logger.js';
import { formatRows, runChecks } from './checks.js';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('\nUsage: npm run check [-- --send]\n\n  --send   also post a test message to the Discord channel\n\nOptional in .env: CHECK_EMAIL_TO (send a real email), TELEGRAM_CHAT_ID (send a Telegram message).\n');
  process.exit(0);
}

loadDotEnv();
const config = loadConfig();
const types = new CredentialTypeRegistry();
const dbFile = join(config.dataDir, 'flowforge.db');

let resolve: (type: string) => ResolvedCredential;
if (existsSync(dbFile)) {
  const service = new CredentialsService({
    repo: new CredentialsRepo(openDatabase(dbFile)),
    cipher: new CredentialCipher(loadEncryptionKey(config.dataDir, config.encryptionKey)),
    types,
    logger: silentLogger,
  });
  const node = { name: 'npm run check' } as unknown as WorkflowNode;
  resolve = (type) => service.resolve(node, type);
} else {
  // FlowForge never started here: only .env can hold the keys.
  resolve = (typeName) => {
    const type = types.get(typeName)!;
    const data = fromEnv(type, process.env);
    if (!data) throw new MissingCredentialError(typeName, type.displayName, type.envRequired?.[0], type.docsAnchor);
    return { data: completeData(type, data), source: 'env', name: '.env' };
  };
}

console.log('\nFlowForge check: one real call per integration\n');
const rows = await runChecks({ resolve, types, env: process.env, send: args.includes('--send') });
console.log(formatRows(rows, process.stdout.isTTY === true));
console.log('');
process.exit(rows.some((r) => r.status === 'FAIL') ? 1 : 0);
