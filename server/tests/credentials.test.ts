import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CredentialSummary, CredentialTypeInfo, WorkflowNode } from '@flowforge/shared';
import { CredentialCipher, CredentialDecryptError, loadEncryptionKey } from '../src/credentials/cipher.js';
import { CredentialError, MissingCredentialError } from '../src/engine/errors.js';
import { capturingLogger, makeTestApp, type TestApp } from './helpers.js';
import { startFakeSmtp, smtpData, type FakeSmtp } from './smtp-helpers.js';
import { chain, node, signedIn, type Agent } from './trigger-helpers.js';

const SECRET = 'Sup3r-S3cret-Pa55w0rd!';
const LOGIN = { user: 'ada@flowforge.test', pass: SECRET };

let t: TestApp | undefined;
let smtp: FakeSmtp | undefined;

afterEach(async () => {
  await t?.close();
  await smtp?.close();
  t = undefined;
  smtp = undefined;
});

async function app(options: Parameters<typeof makeTestApp>[1] = {}, overrides: Parameters<typeof makeTestApp>[0] = {}): Promise<{ t: TestApp; agent: Agent }> {
  t = await makeTestApp(overrides, options);
  return { t, agent: await signedIn(t) };
}

/** Every byte SQLite wrote for this database (main file, WAL, journal). */
function databaseBytes(dir: string): Buffer {
  return Buffer.concat(
    readdirSync(dir)
      .filter((f) => f.startsWith('flowforge.db'))
      .map((f) => readFileSync(join(dir, f))),
  );
}

describe('encryption (AES-256-GCM)', () => {
  it('round-trips, uses a fresh IV every time and detects tampering', () => {
    const cipher = new CredentialCipher(Buffer.alloc(32, 7));
    const a = cipher.encrypt('{"password":"hunter2"}', 'cred-1');
    const b = cipher.encrypt('{"password":"hunter2"}', 'cred-1');
    expect(a).toMatch(/^v1:/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('hunter2');
    expect(cipher.decrypt(a, 'cred-1')).toBe('{"password":"hunter2"}');

    const raw = Buffer.from(a.slice(3), 'base64');
    raw[raw.length - 1]! ^= 1;
    expect(() => cipher.decrypt(`v1:${raw.toString('base64')}`, 'cred-1')).toThrow(CredentialDecryptError);
    // The payload is bound to its credential id: it cannot be copied onto another row.
    expect(() => cipher.decrypt(a, 'cred-2')).toThrow(CredentialDecryptError);
    // Another key cannot read it.
    expect(() => new CredentialCipher(Buffer.alloc(32, 8)).decrypt(a, 'cred-1')).toThrow(/encryption key changed/);
  });

  it('generates data/.encryption_key once (owner-only) and reuses it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-key-'));
    const first = loadEncryptionKey(dir);
    const file = join(dir, '.encryption_key');
    expect(first).toHaveLength(32);
    expect(readFileSync(file, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadEncryptionKey(dir).equals(first)).toBe(true);
  });

  it('FLOWFORGE_ENCRYPTION_KEY wins over the file (hex key or passphrase)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-key-'));
    const hex = 'ab'.repeat(32);
    expect(loadEncryptionKey(dir, hex).toString('hex')).toBe(hex);
    expect(loadEncryptionKey(dir, 'a long passphrase for tests')).toHaveLength(32);
    expect(existsSync(join(dir, '.encryption_key'))).toBe(false);
  });
});

describe('credentials API', () => {
  it('needs a session', async () => {
    const { t } = await app();
    const request = (await import('supertest')).default;
    expect((await request(t.app).get('/api/credentials')).status).toBe(401);
    expect((await request(t.app).get('/api/credential-types')).status).toBe(401);
  });

  it('lists the credential types with their schema', async () => {
    const { agent } = await app();
    const types = (await agent.get('/api/credential-types')).body as CredentialTypeInfo[];
    expect(types.map((x) => x.name).sort()).toEqual(['discordWebhookApi', 'googlePalmApi', 'httpBasicAuth', 'httpBearerAuth', 'httpHeaderAuth', 'httpQueryAuth', 'smtp', 'telegramApi']);
    // Every integration credential has a Test button (the same test() runs in `npm run check`).
    for (const name of ['telegramApi', 'discordWebhookApi', 'googlePalmApi']) expect(types.find((x) => x.name === name), name).toMatchObject({ testable: true, envConfigured: false });
    const smtpType = types.find((x) => x.name === 'smtp')!;
    expect(smtpType.testable).toBe(true);
    expect(smtpType.envConfigured).toBe(false);
    expect(smtpType.properties.find((p) => p.name === 'password')).toMatchObject({ password: true, env: 'SMTP_PASS' });
    expect(smtpType.presets?.map((p) => p.id)).toEqual(['gmail', 'brevo']);
    expect(smtpType.presets?.[1]?.values).toMatchObject({ host: 'smtp-relay.brevo.com', port: 587, secure: false });
  });

  it('create / read / update / delete never return a secret', async () => {
    const { agent } = await app();
    const created = await agent.post('/api/credentials').send({ name: 'Gmail', type: 'smtp', data: { host: 'smtp.gmail.com', port: '465', secure: true, user: 'ada@gmail.com', password: SECRET } });
    expect(created.status).toBe(201);
    const cred = created.body as CredentialSummary;
    expect(cred).toMatchObject({ name: 'Gmail', type: 'smtp', isDefault: true, secrets: ['password'] });
    expect(cred.data).toEqual({ host: 'smtp.gmail.com', port: 465, secure: true, user: 'ada@gmail.com' });

    const responses = [created, await agent.get('/api/credentials'), await agent.get(`/api/credentials/${cred.id}`), await agent.get('/api/credentials?type=smtp')];
    for (const res of responses) expect(JSON.stringify(res.body)).not.toContain(SECRET);

    // Editing without retyping the password keeps it; other fields change.
    const edited = await agent.patch(`/api/credentials/${cred.id}`).send({ name: 'Gmail (work)', data: { host: 'smtp.gmail.com', port: 587, secure: false, user: 'ada@gmail.com', password: '' } });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ name: 'Gmail (work)', secrets: ['password'], data: { port: 587, secure: false } });
    expect(JSON.stringify(edited.body)).not.toContain(SECRET);

    // null clears a secret.
    const cleared = await agent.patch(`/api/credentials/${cred.id}`).send({ data: { host: 'smtp.gmail.com', password: null } });
    expect(cleared.body.secrets).toEqual([]);

    expect((await agent.patch(`/api/credentials/${cred.id}`).send({ type: 'httpBasicAuth' })).status).toBe(400);
    expect((await agent.delete(`/api/credentials/${cred.id}`)).status).toBe(204);
    expect((await agent.get(`/api/credentials/${cred.id}`)).status).toBe(404);
    expect((await agent.delete(`/api/credentials/${cred.id}`)).status).toBe(404);
  });

  it('validates input with readable errors', async () => {
    const { agent } = await app();
    const unknown = await agent.post('/api/credentials').send({ name: 'x', type: 'nope', data: {} });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toMatch(/Unknown credential type "nope"/);
    const missing = await agent.post('/api/credentials').send({ name: 'x', type: 'httpBasicAuth', data: { user: 'ada' } });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toBe('Fill in: Password');
    const badPort = await agent.post('/api/credentials').send({ name: 'x', type: 'smtp', data: { host: 'h', port: 'abc' } });
    expect(badPort.status).toBe(400);
    expect(badPort.body.error.message).toBe('Port must be a number');
  });

  it('the first credential of a type is the default; the default can move and survives deletion', async () => {
    const { agent } = await app();
    const make = async (name: string, isDefault?: boolean) =>
      (await agent.post('/api/credentials').send({ name, type: 'httpHeaderAuth', data: { name: 'X-Key', value: name }, isDefault })).body as CredentialSummary;
    const a = await make('A');
    const b = await make('B');
    const c = await make('C', true);
    const defaults = async () => ((await agent.get('/api/credentials?type=httpHeaderAuth')).body as CredentialSummary[]).filter((x) => x.isDefault).map((x) => x.name);
    expect(a.isDefault).toBe(true);
    expect(b.isDefault).toBe(false);
    expect(await defaults()).toEqual(['C']);
    await agent.patch(`/api/credentials/${b.id}`).send({ isDefault: true });
    expect(await defaults()).toEqual(['B']);
    await agent.delete(`/api/credentials/${b.id}`);
    expect(await defaults()).toEqual(['A']);
    // Another type has its own default.
    const basic = (await agent.post('/api/credentials').send({ name: 'Basic', type: 'httpBasicAuth', data: { user: 'u', password: 'p' } })).body as CredentialSummary;
    expect(basic.isDefault).toBe(true);
    expect(await defaults()).toEqual(['A']);
    void c;
  });
});

describe('secrets at rest', () => {
  it('the database file contains no plaintext value of a credential', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-data-'));
    const { t, agent } = await app({ dbFile: join(dir, 'flowforge.db') }, { dataDir: dir });
    const res = await agent.post('/api/credentials').send({ name: 'Mail', type: 'smtp', data: { host: 'mail.secret-host.example', port: 465, user: 'ada@secret-user.example', password: SECRET } });
    expect(res.status).toBe(201);
    await agent.patch(`/api/credentials/${res.body.id}`).send({ data: { host: 'mail.secret-host.example', user: 'ada@secret-user.example', password: `${SECRET}-v2` } });
    t.ctx.db.pragma('wal_checkpoint(TRUNCATE)');

    const bytes = databaseBytes(dir);
    expect(bytes.length).toBeGreaterThan(1000);
    // Sanity check: the name is stored in clear, so the search itself works.
    expect(bytes.includes(Buffer.from('Mail'))).toBe(true);
    for (const plain of [SECRET, 'mail.secret-host.example', 'ada@secret-user.example']) {
      expect(bytes.includes(Buffer.from(plain)), plain).toBe(false);
      expect(bytes.includes(Buffer.from(plain, 'utf16le')), `${plain} (utf16)`).toBe(false);
    }
    // What is stored is the versioned AES-GCM payload.
    const row = t.ctx.db.prepare('SELECT data FROM credentials WHERE id = ?').get(res.body.id) as { data: string };
    expect(row.data).toMatch(/^v1:[A-Za-z0-9+/=]+$/);
    expect(readFileSync(join(dir, '.encryption_key'), 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a credential saved with another key is reported, not crashed on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-data-'));
    const dbFile = join(dir, 'flowforge.db');
    const first = await app({ dbFile }, { dataDir: dir, encryptionKey: 'the first key 0123456789' });
    const created = await first.agent.post('/api/credentials').send({ name: 'Mail', type: 'smtp', data: { host: 'h', password: SECRET } });
    await first.t.close();

    const second = await app({ dbFile }, { dataDir: dir, encryptionKey: 'another key 0123456789abc' });
    const agent = (await import('supertest')).default.agent(second.t.app);
    await agent.post('/api/auth/login').send({ email: 'owner@flowforge.test', password: 'Forge2026' });
    const list = (await agent.get('/api/credentials')).body as CredentialSummary[];
    expect(list[0]).toMatchObject({ name: 'Mail', data: {}, secrets: [] });
    expect(list[0]!.error).toMatch(/encryption key changed/);
    const node = { name: 'Send', credentials: { smtp: { id: created.body.id, name: 'Mail' } } } as unknown as WorkflowNode;
    expect(() => second.t.ctx.credentials.resolve(node, 'smtp')).toThrow(CredentialError);
    // Entering the values again repairs it.
    const fixed = await agent.patch(`/api/credentials/${created.body.id}`).send({ data: { host: 'h2', password: 'new' } });
    expect(fixed.body).toMatchObject({ data: { host: 'h2' }, secrets: ['password'] });
    expect(fixed.body.error).toBeUndefined();
  });
});

describe('lookup order', () => {
  const smtpNode = (credentials?: WorkflowNode['credentials']) => ({ name: 'Send Email', type: 'flowforge.sendEmail', credentials }) as unknown as WorkflowNode;
  const ENV = { SMTP_HOST: 'env.example', SMTP_PORT: '587', SMTP_USER: 'env-user', SMTP_PASS: 'env-pass', SMTP_FROM: 'Env <env@example.com>' };

  it('node-selected credential → default of the type → .env → MissingCredentialError', async () => {
    const { t, agent } = await app({ env: ENV });
    const service = t.ctx.credentials;

    // 3. Nothing saved: .env is used (port 587 ⇒ SSL/TLS off).
    expect(service.resolve(smtpNode(), 'smtp')).toEqual({
      source: 'env',
      name: '.env',
      data: { host: 'env.example', port: 587, secure: false, user: 'env-user', password: 'env-pass', from: 'Env <env@example.com>' },
    });

    // 2. A default credential beats .env.
    const first = (await agent.post('/api/credentials').send({ name: 'First', type: 'smtp', data: { host: 'first.example', user: 'one', password: 'p1' } })).body as CredentialSummary;
    const second = (await agent.post('/api/credentials').send({ name: 'Second', type: 'smtp', data: { host: 'second.example', port: 587, secure: false, user: 'two', password: 'p2' } })).body as CredentialSummary;
    expect(service.resolve(smtpNode(), 'smtp')).toMatchObject({ source: 'credential', id: first.id, name: 'First', data: { host: 'first.example', port: 465, secure: true, password: 'p1' } });

    // 1. The credential selected on the node beats the default.
    expect(service.resolve(smtpNode({ smtp: { id: second.id, name: 'Second' } }), 'smtp')).toMatchObject({ id: second.id, data: { host: 'second.example', password: 'p2' } });
    // Imported workflow: unknown id, known name.
    expect(service.resolve(smtpNode({ smtp: { id: 'id-from-another-machine', name: 'Second' } }), 'smtp')).toMatchObject({ id: second.id });
    // Unknown id and name: falls back to the default.
    expect(service.resolve(smtpNode({ smtp: { id: 'gone', name: 'Gone' } }), 'smtp')).toMatchObject({ id: first.id });
    // A credential of another type is never used.
    const basic = (await agent.post('/api/credentials').send({ name: 'Basic', type: 'httpBasicAuth', data: { user: 'u', password: 'p' } })).body as CredentialSummary;
    expect(service.resolve(smtpNode({ smtp: { id: basic.id, name: 'Basic' } }), 'smtp')).toMatchObject({ id: first.id });

    // Without default and without the node selection: back to .env.
    await agent.patch(`/api/credentials/${first.id}`).send({ isDefault: false });
    expect(service.resolve(smtpNode(), 'smtp')).toMatchObject({ source: 'env' });
  });

  it('4. no credential and no .env: MissingCredentialError naming the variable and the docs section', async () => {
    const { t } = await app();
    let error: unknown;
    try {
      t.ctx.credentials.resolve(smtpNode(), 'smtp');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(MissingCredentialError);
    expect(error).toMatchObject({ message: 'SMTP credentials are missing', credentialType: 'smtp', envVar: 'SMTP_HOST', docsAnchor: '#email-smtp' });
    expect((error as MissingCredentialError).hint).toBe('Add them on the Credentials page or set SMTP_HOST in .env (see API_SETUP.md#email-smtp).');
    // Types without a .env mapping have no fallback.
    expect(() => t.ctx.credentials.resolve({ name: 'Webhook' } as WorkflowNode, 'httpBasicAuth')).toThrow('Basic Auth credentials are missing');
  });

  it('.env fallback: incomplete variables do not count; SMTP_SECURE and the port are coerced', async () => {
    const { t, agent } = await app({ env: { SMTP_USER: 'only-user', SMTP_PASS: 'x' } });
    expect(() => t.ctx.credentials.resolve(smtpNode(), 'smtp')).toThrow(MissingCredentialError);
    expect(((await agent.get('/api/credential-types')).body as CredentialTypeInfo[]).find((x) => x.name === 'smtp')!.envConfigured).toBe(false);
    await t.close();

    const second = await app({ env: { SMTP_HOST: 'smtp.gmail.com', SMTP_SECURE: 'true', SMTP_USER: 'u', SMTP_PASS: 'abcd efgh ijkl mnop' } });
    expect(second.t.ctx.credentials.resolve(smtpNode(), 'smtp').data).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true });
    const types = (await second.agent.get('/api/credential-types')).body as CredentialTypeInfo[];
    expect(types.find((x) => x.name === 'smtp')!.envConfigured).toBe(true);
    expect(JSON.stringify(types)).not.toContain('abcd efgh');
  });
});

describe('Test button', () => {
  it('tests unsaved values, saved credentials (secret filled from the store) and the .env fallback', async () => {
    smtp = await startFakeSmtp(LOGIN);
    const { agent } = await app({ env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false', SMTP_USER: LOGIN.user, SMTP_PASS: LOGIN.pass } });

    const good = await agent.post('/api/credentials/test').send({ type: 'smtp', data: smtpData(smtp.port, LOGIN) });
    expect(good.body).toMatchObject({ ok: true, message: `Connected to 127.0.0.1:${smtp.port} and signed in as ${LOGIN.user}.` });
    expect(typeof good.body.durationMs).toBe('number');

    const wrong = await agent.post('/api/credentials/test').send({ type: 'smtp', data: smtpData(smtp.port, { user: LOGIN.user, pass: 'wrong' }) });
    expect(wrong.status).toBe(200);
    expect(wrong.body.ok).toBe(false);
    expect(wrong.body.message).toBe(`SMTP authentication failed for "${LOGIN.user}" on 127.0.0.1`);
    expect(wrong.body.hint).toMatch(/Check the user and password/);

    const saved = (await agent.post('/api/credentials').send({ name: 'Fake', type: 'smtp', data: smtpData(smtp.port, LOGIN) })).body as CredentialSummary;
    expect((await agent.post(`/api/credentials/${saved.id}/test`)).body.ok).toBe(true);
    // Editing: the password field is empty, the saved one is used.
    const editing = await agent.post('/api/credentials/test').send({ type: 'smtp', id: saved.id, data: { host: '127.0.0.1', port: smtp.port, secure: false, user: LOGIN.user, password: '' } });
    expect(editing.body.ok).toBe(true);
    // …and a changed user is tested with the saved password.
    const otherUser = await agent.post('/api/credentials/test').send({ type: 'smtp', id: saved.id, data: { host: '127.0.0.1', port: smtp.port, secure: false, user: 'someone-else' } });
    expect(otherUser.body.ok).toBe(false);

    expect((await agent.post('/api/credentials/env/test?type=smtp')).body.ok).toBe(true);
    expect((await agent.post('/api/credentials/nope/test')).status).toBe(404);
    for (const res of [good, wrong, editing, otherUser]) expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('reports unreachable servers and missing fields without throwing', async () => {
    const { agent } = await app();
    const empty = await agent.post('/api/credentials/test').send({ type: 'smtp', data: {} });
    expect(empty.body).toMatchObject({ ok: false, message: 'Fill in: Host' });
    const refused = await agent.post('/api/credentials/test').send({ type: 'smtp', data: { host: '127.0.0.1', port: 1, secure: false } });
    expect(refused.body.ok).toBe(false);
    expect(refused.body.message).toMatch(/127\.0\.0\.1:1/);
    const untestable = await agent.post('/api/credentials/test').send({ type: 'httpBasicAuth', data: { user: 'a', password: 'b' } });
    expect(untestable.body).toMatchObject({ ok: false, message: 'Basic Auth credentials cannot be tested' });
  });
});

describe('secrets never leak', () => {
  it('not into execution data, the executions API, stored events, logs or the database', async () => {
    smtp = await startFakeSmtp(LOGIN);
    const dir = mkdtempSync(join(tmpdir(), 'ff-data-'));
    const logger = capturingLogger();
    const { t, agent } = await app({ dbFile: join(dir, 'flowforge.db'), logger }, { dataDir: dir });
    const cred = (await agent.post('/api/credentials').send({ name: 'Fake SMTP', type: 'smtp', data: smtpData(smtp.port, LOGIN) })).body as CredentialSummary;

    const nodes = [
      node('Start', 'manualTrigger'),
      { ...node('Send', 'sendEmail', { toEmail: 'bob@example.com', subject: 'Hi', emailFormat: 'text', text: 'Hello Bob' }), credentials: { smtp: { id: cred.id, name: cred.name } } },
      // A failing run must not print the credential either.
      { ...node('Broken', 'sendEmail', { toEmail: '', subject: 'x', emailFormat: 'text', text: 'x' }), credentials: { smtp: { id: cred.id, name: cred.name } } },
    ];
    const run = await agent.post('/api/dev/run').send({ name: 'Leak check', nodes, connections: chain('Start', 'Send', 'Broken') });
    expect(run.body.status).toBe('error');
    expect(run.body.nodes.map((n: { node: string; status: string }) => `${n.node}:${n.status}`)).toEqual(['Start:success', 'Send:success', 'Broken:error']);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.user).toBe(LOGIN.user);

    const detail = await agent.get(`/api/executions/${run.body.executionId}`);
    expect(detail.status).toBe(200);
    const list = await agent.get('/api/executions');
    for (const body of [run.body, detail.body, list.body]) expect(JSON.stringify(body)).not.toContain(SECRET);
    // The node keeps only a reference to the credential.
    const stored = (detail.body.workflow.nodes as WorkflowNode[]).find((n) => n.name === 'Send')!;
    expect(stored.credentials).toEqual({ smtp: { id: cred.id, name: 'Fake SMTP' } });

    t.ctx.db.pragma('wal_checkpoint(TRUNCATE)');
    expect(databaseBytes(dir).includes(Buffer.from(SECRET))).toBe(false);
    expect(logger.lines.join('\n')).not.toContain(SECRET);
    expect(logger.lines.some((l) => l.includes('Credential "Fake SMTP" (SMTP) created'))).toBe(true);
  });

  it('$env never exposes SMTP settings to expressions', async () => {
    const { publicEnv } = await import('../src/engine/env.js');
    const visible = publicEnv({ SMTP_HOST: 'h', SMTP_PASS: 'p', SMTP_USER: 'u', FLOWFORGE_ENCRYPTION_KEY: 'k', PATH: '/bin' });
    expect(visible).toEqual({ SMTP_HOST: 'h', PATH: '/bin' });
  });
});

describe('upgrade from inline Webhook passwords (Phase 3)', () => {
  it('moves them to encrypted credentials once, keeps the webhooks working and cleans stored copies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-data-'));
    const { t, agent } = await app({ dbFile: join(dir, 'flowforge.db') }, { dataDir: dir });
    const request = (await import('supertest')).default;
    const legacy = (name: string, parameters: Record<string, unknown>) => ({ ...node(name, 'webhook', parameters) });
    // Workflows as Phase 3 stored them: the secrets sit in the node parameters.
    const nodes = [
      legacy('Basic hook', { path: 'old-basic', authentication: 'basicAuth', basicAuthUser: 'ada', basicAuthPassword: 'inline-Pa55' }),
      legacy('Header hook', { path: 'old-header', authentication: 'headerAuth', headerAuthName: 'X-Token', headerAuthValue: 'inline-T0ken' }),
      legacy('Open hook', { path: 'old-open', authentication: 'none', basicAuthUser: '', basicAuthPassword: '' }),
    ];
    const created = await agent.post('/api/workflows').send({ name: 'Legacy', nodes, connections: {} });
    const id = created.body.id as string;
    t.ctx.db.prepare('UPDATE workflows SET active = 1 WHERE id = ?').run(id);
    // …and an old execution that kept a copy of that workflow.
    t.ctx.db.prepare("INSERT INTO executions (workflow_id, workflow_name, mode, status, created_at) VALUES (?, 'Legacy', 'webhook', 'success', ?)").run(id, new Date().toISOString());
    const executionId = (t.ctx.db.prepare('SELECT MAX(id) AS id FROM executions').get() as { id: number }).id;
    t.ctx.db.prepare('INSERT INTO execution_data (execution_id, workflow) VALUES (?, ?)').run(executionId, JSON.stringify({ name: 'Legacy', nodes, connections: {} }));

    await t.boot();

    const wf = (await agent.get(`/api/workflows/${id}`)).body as { active: boolean; nodes: WorkflowNode[] };
    expect(wf.active).toBe(true);
    expect(JSON.stringify(wf)).not.toMatch(/inline-Pa55|inline-T0ken|basicAuthPassword|headerAuthValue/);
    expect(wf.nodes[0]!.credentials?.httpBasicAuth?.name).toBe('Legacy · Basic hook');
    expect(wf.nodes[1]!.credentials?.httpHeaderAuth?.name).toBe('Legacy · Header hook');
    expect(wf.nodes[2]!.credentials).toBeUndefined();
    expect(wf.nodes[0]!.parameters).toEqual({ path: 'old-basic', authentication: 'basicAuth' });

    // Same behaviour as before the upgrade.
    expect((await request(t.app).get('/webhook/old-basic')).status).toBe(401);
    expect((await request(t.app).get('/webhook/old-basic').auth('ada', 'inline-Pa55')).status).toBe(200);
    expect((await request(t.app).get('/webhook/old-header').set('X-Token', 'nope')).status).toBe(403);
    expect((await request(t.app).get('/webhook/old-header').set('X-Token', 'inline-T0ken')).status).toBe(200);
    expect((await request(t.app).get('/webhook/old-open')).status).toBe(200);

    const snapshot = t.ctx.db.prepare('SELECT workflow FROM execution_data WHERE execution_id = ?').get(executionId) as { workflow: string };
    expect(snapshot.workflow).not.toMatch(/inline-Pa55|inline-T0ken/);
    expect(JSON.stringify((await agent.get('/api/credentials')).body)).not.toMatch(/inline-Pa55|inline-T0ken/);
    t.ctx.db.pragma('wal_checkpoint(TRUNCATE)');
    const bytes = databaseBytes(dir);
    expect(bytes.includes(Buffer.from('inline-Pa55'))).toBe(false);
    expect(bytes.includes(Buffer.from('inline-T0ken'))).toBe(false);

    // It runs once: a second boot creates nothing new.
    const { migrateLegacyWebhookAuth } = await import('../src/credentials/legacy-webhook-auth.js');
    expect(migrateLegacyWebhookAuth(t.ctx.db, t.ctx.credentials, t.ctx.logger)).toEqual({ workflows: 0, executions: 0 });
    expect((await agent.get('/api/credentials')).body).toHaveLength(2);
  });
});
