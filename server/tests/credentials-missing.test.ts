import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from './helpers.js';
import { node, signedIn } from './trigger-helpers.js';

let t: TestApp;
afterEach(async () => {
  await t?.close();
});

describe('POST /api/credentials/missing (warning badges of the editor)', () => {
  const nodes = [
    node('Start', 'manualTrigger'),
    node('Mail', 'sendEmail'),
    node('Bot', 'telegram'),
    node('Off', 'discord', {}, { disabled: true }),
    node('Plain call', 'httpRequest', { url: 'https://example.com' }),
    node('Signed call', 'httpRequest', { url: 'https://example.com', authentication: 'bearerAuth' }),
    node('Model', 'geminiChatModel'),
    node('Ghost', 'flowforge.doesNotExist'),
  ];

  it('lists the nodes whose credential is not configured, by name only', async () => {
    t = await makeTestApp({}, { env: { TELEGRAM_BOT_TOKEN: '123:abc-secret-token' } });
    const agent = await signedIn(t);
    const res = await agent.post('/api/credentials/missing').send({ nodes });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Telegram is covered by .env, the disabled node and the unknown type are ignored, "None" needs nothing.
    expect(res.body.missing).toEqual([
      { node: 'Mail', credentialType: 'smtp', displayName: 'SMTP' },
      { node: 'Signed call', credentialType: 'httpBearerAuth', displayName: 'Bearer Auth' },
      { node: 'Model', credentialType: 'googlePalmApi', displayName: 'Google Gemini API' },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('abc-secret-token');

    await agent.post('/api/credentials').send({ name: 'Gemini', type: 'googlePalmApi', data: { apiKey: 'AIzaSy-test-000' } }).expect(201);
    const after = await agent.post('/api/credentials/missing').send({ nodes });
    expect(after.body.missing.map((m: { node: string }) => m.node)).toEqual(['Mail', 'Signed call']);
  });

  it('needs a login and a list of nodes', async () => {
    t = await makeTestApp();
    const anonymous = await (await import('supertest')).default(t.app).post('/api/credentials/missing').send({ nodes: [] });
    expect(anonymous.status).toBe(401);
    const agent = await signedIn(t);
    expect((await agent.post('/api/credentials/missing').send({})).status).toBe(400);
    expect((await agent.post('/api/credentials/missing').send({ nodes: [] })).body).toEqual({ missing: [] });
  });
});
