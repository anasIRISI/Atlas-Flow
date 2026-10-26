import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CredentialSummary, JsonObject } from '@flowforge/shared';
import { buildEmbed, parseColor, parseWebhookUrl } from '../src/integrations/discord.js';
import { startDiscordMock, WEBHOOK_ID, WEBHOOK_TOKEN, type DiscordMock } from './discord-mock.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { chain, node, signedIn, type Agent } from './trigger-helpers.js';

let t: TestApp;
let agent: Agent;
let mock: DiscordMock;

beforeEach(async () => {
  mock = await startDiscordMock();
});
afterEach(async () => {
  await t?.close();
  await mock.close();
});

async function start(env: NodeJS.ProcessEnv = {}) {
  t = await makeTestApp({}, { env });
  agent = await signedIn(t);
}

async function saveCredential(webhookUri: string = mock.url) {
  const res = await agent.post('/api/credentials').send({ name: 'Test Discord', type: 'discordWebhookApi', data: { webhookUri } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as CredentialSummary;
}

interface RunSummary {
  status: string;
  error?: { message: string; hint?: string; credentialType?: string; credentialId?: string; envVar?: string; docsAnchor?: string; node?: string; itemIndex?: number };
  nodes: { node: string; status: string; error?: string }[];
  output: JsonObject[][];
}

async function discord(parameters: JsonObject, items: JsonObject[] = [{}]): Promise<RunSummary> {
  const nodes = [
    node('Start', 'manualTrigger'),
    node('Items', 'code', { jsCode: `return ${JSON.stringify(items)}.map((json) => ({ json }));` }),
    node('Discord', 'discord', parameters),
  ];
  const res = await agent.post('/api/dev/run').send({ name: 'Discord', nodes, connections: chain('Start', 'Items', 'Discord') });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as RunSummary;
}

const embed = (values: JsonObject) => ({ embeds: { embed: [values] } });
const posts = () => mock.requests.filter((r) => r.method === 'POST');
const noSecret = (value: unknown) => {
  const text = JSON.stringify(value);
  expect(text).not.toContain(WEBHOOK_TOKEN);
  expect(text).not.toContain(mock.url);
};

describe('webhook URL and embed helpers', () => {
  it('validates the path shape, strips the query and never echoes the URL', () => {
    expect(parseWebhookUrl(` https://discord.com/api/webhooks/${WEBHOOK_ID}/abc-DEF_1?wait=true&thread_id=5 `)).toMatchObject({ id: WEBHOOK_ID, token: 'abc-DEF_1', url: `https://discord.com/api/webhooks/${WEBHOOK_ID}/abc-DEF_1` });
    expect(parseWebhookUrl(`https://discordapp.com/api/v10/webhooks/${WEBHOOK_ID}/tok`).url).toBe(`https://discordapp.com/api/v10/webhooks/${WEBHOOK_ID}/tok`);
    expect(parseWebhookUrl(mock.url).url).toBe(mock.url);
    for (const bad of ['', 'not a url', 'ftp://discord.com/api/webhooks/1/x', 'https://discord.com/api/webhooks/abc/tok', 'https://example.com/webhooks/123', `https://discord.com/api/webhooks/${WEBHOOK_ID}/tok/slack`, 'https://discord.com/channels/1/2']) {
      let caught: (Error & { auth?: boolean; hint?: string }) | undefined;
      try {
        parseWebhookUrl(bad);
      } catch (err) {
        caught = err as Error;
      }
      expect(caught, bad).toBeDefined();
      expect(caught!.auth).toBe(true);
      expect(caught!.hint).toMatch(/discord\.com\/api\/webhooks/);
      if (bad.length > 8) expect(`${caught!.message} ${caught!.hint}`).not.toContain(bad);
    }
  });

  it('converts colors and drops empty embeds', () => {
    expect(parseColor('#5865F2')).toBe(5793266);
    expect(parseColor('fff')).toBe(0xffffff);
    expect(parseColor(255)).toBe(255);
    expect(() => parseColor('blue')).toThrow(/not valid/);
    expect(buildEmbed({ color: '#5865F2' })).toBeUndefined();
    expect(buildEmbed({ title: 'Hi', color: '#000000' })).toEqual({ title: 'Hi', color: 0 });
  });
});

describe('Discord node: send', () => {
  it('sends a message, asks for wait=true and returns the Message object', async () => {
    await start();
    await saveCredential();
    const run = await discord({ content: 'Hello **world**' });
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toMatchObject({ path: `/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`, query: { wait: 'true' }, body: { content: 'Hello **world**' } });
    expect(posts()[0]!.body).not.toHaveProperty('tts');
    expect(posts()[0]!.body).not.toHaveProperty('flags');
    expect(run.output[0]![0]).toMatchObject({ id: '1000', channel_id: '777', content: 'Hello **world**', embeds: [] });
  });

  it('sends username, avatar, tts, flags and thread_id', async () => {
    await start();
    await saveCredential();
    const run = await discord({ content: 'psst', options: { username: 'Forge Bot', avatarUrl: 'https://example.com/a.png', tts: true, threadId: '4242', suppressEmbeds: true, suppressNotifications: true } });
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(posts()[0]!.query).toEqual({ wait: 'true', thread_id: '4242' });
    expect(posts()[0]!.body).toEqual({ content: 'psst', username: 'Forge Bot', avatar_url: 'https://example.com/a.png', tts: true, flags: 4 | 4096 });
  });

  it('builds a full embed: hex color to integer, fields, timestamp now; empty embeds are dropped', async () => {
    await start();
    await saveCredential();
    const before = Date.now();
    const run = await discord({
      embeds: {
        embed: [
          {
            title: 'Order #12',
            description: 'Paid',
            url: 'https://example.com/o/12',
            color: '#5865F2',
            authorName: 'Shop',
            authorUrl: 'https://example.com',
            authorIconUrl: 'https://example.com/i.png',
            thumbnailUrl: 'https://example.com/t.png',
            imageUrl: 'https://example.com/big.png',
            footerText: 'FlowForge',
            footerIconUrl: 'https://example.com/f.png',
            timestamp: 'now',
            fieldsJson: '[{"name":"Total","value":"42 EUR","inline":true},{"name":"Status","value":"OK"}]',
          },
          { color: '#FF0000', timestamp: 'none', fieldsJson: '[]' },
          { title: 'Custom date', timestamp: 'custom', timestampValue: '2026-10-12T09:30:00+02:00', fieldsJson: [{ name: 'a', value: 'b' }] },
        ],
      },
    });
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    const sent = posts()[0]!.body as { content?: unknown; embeds: Array<Record<string, unknown>> };
    expect(sent).not.toHaveProperty('content');
    expect(sent.embeds).toHaveLength(2);
    expect(sent.embeds[0]).toMatchObject({
      title: 'Order #12',
      description: 'Paid',
      url: 'https://example.com/o/12',
      color: 5793266,
      author: { name: 'Shop', url: 'https://example.com', icon_url: 'https://example.com/i.png' },
      thumbnail: { url: 'https://example.com/t.png' },
      image: { url: 'https://example.com/big.png' },
      footer: { text: 'FlowForge', icon_url: 'https://example.com/f.png' },
      fields: [{ name: 'Total', value: '42 EUR', inline: true }, { name: 'Status', value: 'OK' }],
    });
    const stamp = Date.parse(String(sent.embeds[0]!.timestamp));
    expect(stamp).toBeGreaterThanOrEqual(before - 1000);
    expect(stamp).toBeLessThanOrEqual(Date.now() + 1000);
    expect(sent.embeds[1]).toMatchObject({ title: 'Custom date', timestamp: '2026-10-12T07:30:00.000Z', fields: [{ name: 'a', value: 'b' }] });
    expect(run.output[0]![0]!.embeds).toHaveLength(2);
  });

  it('without wait: no wait query, answer 204, output is { success: true }', async () => {
    await start();
    await saveCredential();
    const run = await discord({ content: 'quiet', options: { wait: false } });
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(posts()[0]!.query).toEqual({});
    expect(run.output[0]).toEqual([{ success: true }]);
  });

  it('refuses to send nothing', async () => {
    await start();
    await saveCredential();
    const run = await discord({ content: '' });
    expect(run.status).toBe('error');
    expect(run.error!.message).toMatch(/nothing to send/);
    expect(mock.requests).toHaveLength(0);
  });
});

describe('Discord node: edit / delete / get', () => {
  it('edits, reads and deletes a message sent by the webhook', async () => {
    await start();
    await saveCredential();
    const sent = await discord({ content: 'v1' });
    const id = String(sent.output[0]![0]!.id);

    const edited = await discord({ operation: 'editMessage', messageId: id, content: 'v2', ...embed({ title: 'T', color: '#5865F2', timestamp: 'none', fieldsJson: '[]' }), options: { threadId: '9' } });
    expect(edited.status, JSON.stringify(edited.error)).toBe('success');
    const patch = mock.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.path).toBe(`/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}/messages/${id}`);
    expect(patch.query).toEqual({ thread_id: '9' });
    expect(patch.body).toMatchObject({ content: 'v2', embeds: [{ title: 'T', color: 5793266 }] });
    expect(edited.output[0]![0]).toMatchObject({ id, content: 'v2' });

    const got = await discord({ operation: 'getMessage', messageId: id });
    expect(got.output[0]![0]).toMatchObject({ id, content: 'v2' });
    expect(mock.requests.at(-1)).toMatchObject({ method: 'GET', path: `/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}/messages/${id}` });

    const deleted = await discord({ operation: 'deleteMessage', messageId: ` ${id} ` });
    expect(deleted.output[0]).toEqual([{ success: true, messageId: id }]);
    expect(mock.requests.at(-1)).toMatchObject({ method: 'DELETE' });

    const gone = await discord({ operation: 'getMessage', messageId: id });
    expect(gone.status).toBe('error');
    expect(gone.error!.message).toMatch(/cannot find this message/);
    expect(gone.error!.credentialType).toBeUndefined();
    noSecret([sent, edited, got, deleted, gone]);
  });

  it('checks the message ID before any request', async () => {
    await start();
    await saveCredential();
    for (const messageId of ['', '12/../34', 'abc']) {
      const run = await discord({ operation: 'deleteMessage', messageId });
      expect(run.status, messageId).toBe('error');
      expect(run.error!.message).toMatch(/message ID/);
    }
    expect(mock.requests).toHaveLength(0);
  });
});

describe('Discord node: limits are checked before any request', () => {
  it('2001 characters ⇒ clear error; truncate cuts at 2000', async () => {
    await start();
    await saveCredential();
    const run = await discord({ content: 'x'.repeat(2001) });
    expect(run.status).toBe('error');
    expect(run.error!.message).toBe('The message is 2001 characters long; Discord allows 2000');
    expect(run.error!.hint).toMatch(/Truncate/);
    expect(mock.requests).toHaveLength(0);

    const cut = await discord({ content: 'y'.repeat(2500), options: { longContent: 'truncate' } });
    expect(cut.status, JSON.stringify(cut.error)).toBe('success');
    const content = String(posts()[0]!.body!.content);
    expect(content).toHaveLength(2000);
    expect(content.endsWith('…')).toBe(true);
    expect(content.startsWith('yyy')).toBe(true);

    const exact = await discord({ content: 'z'.repeat(2000) });
    expect(exact.status).toBe('success');
  });

  it('11 embeds, per-field limits, 25 fields and the 6000 total', async () => {
    await start();
    await saveCredential();
    const many = await discord({ embeds: { embed: Array.from({ length: 11 }, (_v, i) => ({ title: `e${i}`, fieldsJson: '[]' })) } });
    expect(many.error!.message).toBe('The message has 11 embeds; Discord allows 10');

    const title = await discord(embed({ title: 't'.repeat(257), fieldsJson: '[]' }));
    expect(title.error!.message).toBe('Embed 1: the title is 257 characters long; Discord allows 256');
    const description = await discord(embed({ description: 'd'.repeat(4097), fieldsJson: '[]' }));
    expect(description.error!.message).toBe('Embed 1: the description is 4097 characters long; Discord allows 4096');
    const footer = await discord(embed({ footerText: 'f'.repeat(2049), fieldsJson: '[]' }));
    expect(footer.error!.message).toBe('Embed 1: the footer text is 2049 characters long; Discord allows 2048');
    const author = await discord(embed({ authorName: 'a'.repeat(257), fieldsJson: '[]' }));
    expect(author.error!.message).toBe('Embed 1: the author name is 257 characters long; Discord allows 256');
    const fieldValue = await discord(embed({ fieldsJson: JSON.stringify([{ name: 'n', value: 'v'.repeat(1025) }]) }));
    expect(fieldValue.error!.message).toBe('Embed 1, field 1: the value is 1025 characters long; Discord allows 1024');
    const fieldName = await discord(embed({ fieldsJson: JSON.stringify([{ name: 'n'.repeat(257), value: 'v' }]) }));
    expect(fieldName.error!.message).toBe('Embed 1, field 1: the name is 257 characters long; Discord allows 256');
    const empty = await discord(embed({ fieldsJson: JSON.stringify([{ name: 'n', value: '' }]) }));
    expect(empty.error!.message).toMatch(/field 1: the value is empty/);
    const fields = await discord(embed({ fieldsJson: JSON.stringify(Array.from({ length: 26 }, (_v, i) => ({ name: `n${i}`, value: 'v' }))) }));
    expect(fields.error!.message).toBe('Embed 1 has 26 fields; Discord allows 25');
    const badJson = await discord(embed({ title: 'x', fieldsJson: '{oops' }));
    expect(badJson.error!.message).toMatch(/not valid JSON/);

    const total = await discord({ embeds: { embed: [{ description: 'a'.repeat(3500), fieldsJson: '[]' }, { description: 'b'.repeat(3000), title: 'T', fieldsJson: '[]' }] } });
    expect(total.error!.message).toBe('The embeds add up to 6501 characters; Discord allows 6000 in total');
    expect(mock.requests).toHaveLength(0);

    const fine = await discord({ embeds: { embed: [{ description: 'a'.repeat(3000), fieldsJson: '[]' }, { description: 'b'.repeat(3000), fieldsJson: '[]' }] } });
    expect(fine.status, JSON.stringify(fine.error)).toBe('success');
  });
});

describe('Discord node: rate limit (429)', () => {
  it('waits retry_after (float seconds) once, then succeeds', async () => {
    await start();
    await saveCredential();
    mock.script.push({ status: 429, body: { message: 'You are being rate limited.', retry_after: 0.05, global: false }, headers: { 'retry-after': '1' } });
    const started = Date.now();
    const run = await discord({ content: 'again' });
    const took = Date.now() - started;
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(posts()).toHaveLength(2);
    expect(took).toBeGreaterThanOrEqual(45);
    expect(took).toBeLessThan(900); // the 1 s Retry-After header was NOT used: the body wins
  });

  it('uses the Retry-After header when the body has no retry_after', async () => {
    await start();
    await saveCredential();
    mock.script.push({ status: 429, raw: 'slow down', headers: { 'retry-after': '0.1' } });
    const run = await discord({ content: 'again' });
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(posts()).toHaveLength(2);
  });

  it('a long wait is not retried: error with the wait in the hint', async () => {
    await start();
    await saveCredential();
    mock.script.push({ status: 429, body: { message: 'You are being rate limited.', retry_after: 30.5, global: true } });
    const run = await discord({ content: 'too much' });
    expect(run.status).toBe('error');
    expect(run.error!.message).toMatch(/rate limiting this webhook for 30\.5 s/);
    expect(run.error!.hint).toMatch(/Discord asks to wait 30\.5 s/);
    expect(posts()).toHaveLength(1);
  });

  it('gives up after 3 tries', async () => {
    await start();
    await saveCredential();
    for (let i = 0; i < 5; i++) mock.script.push({ status: 429, body: { message: 'rate limited', retry_after: 0.02, global: false } });
    const run = await discord({ content: 'stubborn' });
    expect(run.status).toBe('error');
    expect(run.error!.message).toMatch(/after 3 tries/);
    expect(run.error!.hint).toMatch(/Discord asks to wait 0\.02 s/);
    expect(posts()).toHaveLength(3);
  });

  it('the wait is abortable', async () => {
    const { executeWebhook, parseWebhookUrl: parse } = await import('../src/integrations/discord.js');
    mock.script.push({ status: 429, body: { retry_after: 9 } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('canceled by test')), 100);
    const started = Date.now();
    await expect(executeWebhook(parse(mock.url), { content: 'x' }, { signal: controller.signal })).rejects.toThrow('canceled by test');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(mock.requests).toHaveLength(1);
  });
});

describe('Discord node: errors', () => {
  it('unknown webhook (404) and bad token (401) are credential errors with the credential id', async () => {
    await start();
    const unknownId = await saveCredential(mock.url.replace(WEBHOOK_ID, '999999999999999999'));
    const gone = await discord({ content: 'hi' });
    expect(gone.status).toBe('error');
    expect(gone.error).toMatchObject({ credentialType: 'discordWebhookApi', credentialId: unknownId.id });
    expect(gone.error!.message).toMatch(/does not accept this webhook \(Unknown Webhook\)/);
    expect(gone.error!.hint).toMatch(/deleted or the URL is incomplete/);

    await agent.delete(`/api/credentials/${unknownId.id}`);
    const badToken = await saveCredential(mock.url.replace(WEBHOOK_TOKEN, 'wrongtoken'));
    const unauthorized = await discord({ content: 'hi' });
    expect(unauthorized.error).toMatchObject({ credentialType: 'discordWebhookApi', credentialId: badToken.id });
    expect(unauthorized.error!.message).toMatch(/Invalid Webhook Token/);
    noSecret([gone, unauthorized]);
    expect(JSON.stringify([gone, unauthorized])).not.toContain('wrongtoken');
  });

  it('a malformed URL in the credential is a credential error that does not echo it', async () => {
    await start();
    const saved = await saveCredential('https://discord.com/channels/12345/67890-private');
    const run = await discord({ content: 'hi' });
    expect(run.error).toMatchObject({ credentialType: 'discordWebhookApi', credentialId: saved.id, message: 'This is not a valid Discord webhook URL' });
    expect(run.error!.hint).toMatch(/\/webhooks\//);
    expect(JSON.stringify(run)).not.toContain('67890-private');
    expect(mock.requests).toHaveLength(0);
  });

  it('400 shows the validation details of Discord (and redacts a token echoed back)', async () => {
    await start();
    await saveCredential();
    mock.script.push({
      status: 400,
      body: {
        message: `Invalid Form Body ${WEBHOOK_TOKEN}`,
        code: 50035,
        errors: { embeds: { 0: { url: { _errors: [{ code: 'URL_TYPE_INVALID_URL', message: 'Not a well formed URL.' }] } } } },
      },
    });
    const run = await discord(embed({ title: 'x', url: 'nope', fieldsJson: '[]' }));
    expect(run.status).toBe('error');
    expect(run.error!.message).toContain('embeds.0.url: Not a well formed URL.');
    expect(run.error!.message).toContain('Invalid Form Body');
    expect(run.error!.credentialType).toBeUndefined();
    noSecret(run);
  });

  it('times out with a clear message', async () => {
    await start();
    await saveCredential();
    mock.script.push({ status: 200, body: {}, delayMs: 1800 });
    const run = await discord({ content: 'slow', options: { timeout: 1 } });
    expect(run.status).toBe('error');
    expect(run.error!.message).toMatch(/No answer from 127\.0\.0\.1:\d+ within 1 s/);
    noSecret(run);
  });

  it('a non-JSON answer is reported, not crashed on', async () => {
    await start();
    await saveCredential();
    mock.script.push({ status: 200, raw: '<html>oops</html>' });
    const run = await discord({ content: 'garbage' });
    expect(run.status).toBe('error');
    expect(run.error!.message).toBe('Discord sent an answer FlowForge could not read');

    mock.script.push({ status: 502, raw: '<html>Bad gateway</html>' });
    const bad = await discord({ content: 'garbage' });
    expect(bad.error!.message).toBe('Discord answered 502');
    expect(bad.error!.hint).toMatch(/try again later/);
  });
});

describe('Discord node: credentials', () => {
  it('missing credential: error names the type and DISCORD_WEBHOOK_URL', async () => {
    await start();
    const run = await discord({ content: 'hi' });
    expect(run.status).toBe('error');
    expect(run.error).toMatchObject({ credentialType: 'discordWebhookApi', envVar: 'DISCORD_WEBHOOK_URL' });
    expect(run.error!.hint).toMatch(/DISCORD_WEBHOOK_URL/);
    expect(mock.requests).toHaveLength(0);
  });

  it('falls back to DISCORD_WEBHOOK_URL in .env', async () => {
    await start({ DISCORD_WEBHOOK_URL: mock.url });
    const run = await discord({ content: 'from env' });
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(posts()[0]!.body).toEqual({ content: 'from env' });
    noSecret(run);
  });

  it('a wrong .env URL is a credential error mentioning .env', async () => {
    await start({ DISCORD_WEBHOOK_URL: mock.url.replace(WEBHOOK_ID, '111111111111111111') });
    const run = await discord({ content: 'hi' });
    expect(run.error!.credentialType).toBe('discordWebhookApi');
    expect(run.error!.hint).toMatch(/\.env \(DISCORD_WEBHOOK_URL\)/);
    noSecret(run);
  });

  it('the Test button does a GET only and never returns the token', async () => {
    await start();
    const ok = await agent.post('/api/credentials/test').send({ type: 'discordWebhookApi', data: { webhookUri: mock.url } });
    expect(ok.body).toMatchObject({ ok: true, message: 'Webhook "Captain Hook" is reachable.' });
    expect(mock.requests.map((r) => r.method)).toEqual(['GET']);
    expect(mock.requests[0]!.path).toBe(`/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`);

    const missing = await agent.post('/api/credentials/test').send({ type: 'discordWebhookApi', data: { webhookUri: mock.url.replace(WEBHOOK_ID, '999999999999999999') } });
    expect(missing.body.ok).toBe(false);
    expect(missing.body.message).toMatch(/Unknown Webhook/);
    const malformed = await agent.post('/api/credentials/test').send({ type: 'discordWebhookApi', data: { webhookUri: 'https://example.com/hello' } });
    expect(malformed.body).toMatchObject({ ok: false, message: 'This is not a valid Discord webhook URL' });

    const saved = await saveCredential();
    const again = await agent.post(`/api/credentials/${saved.id}/test`);
    expect(again.body.ok).toBe(true);
    expect(mock.requests.every((r) => r.method === 'GET')).toBe(true);
    noSecret([ok.body, missing.body, malformed.body, again.body]);
  });
});

describe('Discord node: secrets', () => {
  it('neither the webhook URL nor its token is in the whole run result', async () => {
    await start();
    await saveCredential();
    const sent = await discord({ content: 'Secret check', ...embed({ title: 'T', fieldsJson: '[]' }) });
    const id = String(sent.output[0]![0]!.id);
    const read = await discord({ operation: 'getMessage', messageId: id });
    const failed = await discord({ operation: 'getMessage', messageId: '1' });
    const run = [sent, read, failed];
    expect(run.map((r) => r.status)).toEqual(['success', 'success', 'error']);
    const text = JSON.stringify(run);
    expect(text).not.toContain(WEBHOOK_TOKEN);
    expect(text).not.toContain('tK3n_');
    expect(text).not.toContain('/webhooks/');
    // …and nothing logged on the server side of the execution either.
    const executions = t.ctx.executionsRepo.list({ limit: 50 });
    for (const e of executions) expect(JSON.stringify(t.ctx.executionsRepo.get(e.id))).not.toContain(WEBHOOK_TOKEN);
  });
});
