// `npm run check:email [-- recipient@example.com] [--credential "Name"]`
// Sends a real test email with the SMTP credential (selected, default, or .env) and prints OK / FAIL with the reason.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowNode } from '@flowforge/shared';
import { loadConfig, loadDotEnv } from '../config.js';
import { CredentialCipher, loadEncryptionKey } from '../credentials/cipher.js';
import { completeData, CredentialTypeRegistry, fromEnv } from '../credentials/registry.js';
import { CredentialsService } from '../credentials/service.js';
import { openDatabase } from '../db/index.js';
import { CredentialsRepo } from '../db/repositories/credentials.js';
import { FlowError } from '../engine/errors.js';
import { silentLogger } from '../logger.js';
import { renderEmailHtml, renderEmailText } from '../nodes/_shared/email-template.js';
import { createSmtpTransport, describeSmtpError, smtpSettings, verifySmtp } from '../nodes/_shared/smtp.js';

const ok = (text: string) => console.log(`  \x1b[32mOK\x1b[0m    ${text}`);
const fail = (text: string, hint?: string): never => {
  console.log(`  \x1b[31mFAIL\x1b[0m  ${text}`);
  if (hint) console.log(`        ${hint}`);
  console.log('');
  process.exit(1);
};

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const credentialName = flag('--credential');
const recipientArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--credential');

loadDotEnv();
const config = loadConfig();
console.log('\nFlowForge email check\n');

const dbFile = join(config.dataDir, 'flowforge.db');
const types = new CredentialTypeRegistry();
let credential;
try {
  if (existsSync(dbFile)) {
    const db = openDatabase(dbFile);
    const service = new CredentialsService({
      repo: new CredentialsRepo(db),
      cipher: new CredentialCipher(loadEncryptionKey(config.dataDir, config.encryptionKey)),
      types,
      logger: silentLogger,
    });
    const node = { name: 'check:email', credentials: credentialName ? { smtp: { id: credentialName, name: credentialName } } : undefined } as unknown as WorkflowNode;
    credential = service.resolve(node, 'smtp');
    if (credentialName && credential.name !== credentialName && credential.id !== credentialName) {
      fail(`No SMTP credential named "${credentialName}"`, 'Check the name on the Credentials page.');
    }
  } else {
    // No database yet (FlowForge never started): only .env can provide the settings.
    const data = fromEnv(types.get('smtp')!, process.env);
    if (!data) throw new Error('SMTP credentials are missing');
    credential = { data: completeData(types.get('smtp')!, data), source: 'env' as const, name: '.env' };
  }
} catch (err) {
  fail(
    err instanceof Error ? err.message : String(err),
    err instanceof FlowError && err.hint ? err.hint : 'Create an SMTP credential on the Credentials page, or set SMTP_HOST, SMTP_USER and SMTP_PASS in .env (see API_SETUP.md).',
  );
}

const s = smtpSettings(credential!.data);
const to = recipientArg ?? process.env.SMTP_TEST_TO ?? s.user;
console.log(`  Server   ${s.host}:${s.port} (${s.secure ? 'SSL/TLS' : 'STARTTLS'})`);
console.log(`  Login    ${s.user || '(none)'}`);
console.log(`  Source   ${credential!.source === 'env' ? '.env (SMTP_* variables)' : `credential "${credential!.name}"`}`);
console.log(`  To       ${to || '(nobody)'}\n`);
if (!to) fail('No recipient', 'Run: npm run check:email -- you@example.com');

const verified = await verifySmtp(s);
if (!verified.ok) fail(verified.error.message, verified.error.hint);
ok('connected and signed in');

const content = {
  title: 'FlowForge email check ✅',
  message: `If you can read this, FlowForge can send emails through ${s.host}.\n\nSent at ${new Date().toLocaleString()}.`,
  footer: 'Sent by npm run check:email',
};
const transport = createSmtpTransport(s);
try {
  const info = await transport.sendMail({
    from: String(credential!.data.from || s.user),
    to,
    subject: 'FlowForge email check',
    html: renderEmailHtml(content),
    text: renderEmailText(content),
  });
  ok(`email sent to ${to} (${String(info.response ?? '').slice(0, 60)})`);
  console.log('\n  Check the inbox (and the spam folder) of the recipient.\n');
} catch (err) {
  const problem = describeSmtpError(err, s);
  fail(problem.message, problem.hint);
} finally {
  transport.close();
}
