import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CredentialSummary, JsonObject } from '@flowforge/shared';
import { renderEmailHtml, renderEmailText } from '../src/nodes/_shared/email-template.js';
import { describeSmtpError } from '../src/nodes/_shared/smtp.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { smtpData, startFakeSmtp, startSilentServer, type FakeSmtp } from './smtp-helpers.js';
import { chain, node, signedIn, type Agent } from './trigger-helpers.js';

const LOGIN = { user: 'sender@flowforge.test', pass: 'app-password-123' };

let t: TestApp;
let agent: Agent;
let smtp: FakeSmtp;

beforeEach(async () => {
  smtp = await startFakeSmtp(LOGIN);
});
afterEach(async () => {
  await t?.close();
  await smtp.close();
});

async function start(env: NodeJS.ProcessEnv = {}) {
  t = await makeTestApp({}, { env });
  agent = await signedIn(t);
}

async function saveCredential(data: JsonObject = smtpData(smtp.port, LOGIN), name = 'Test SMTP') {
  const res = await agent.post('/api/credentials').send({ name, type: 'smtp', data });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as CredentialSummary;
}

interface RunSummary {
  status: string;
  error?: { message: string; hint?: string; credentialType?: string; credentialId?: string; envVar?: string; docsAnchor?: string; node?: string; itemIndex?: number };
  nodes: { node: string; status: string; error?: string }[];
  output: JsonObject[][];
}

/** Manual Trigger → (items) → Send Email, run through the dev API. */
async function send(parameters: JsonObject, items: JsonObject[] = [{}], extra: JsonObject = {}): Promise<RunSummary> {
  const nodes = [
    node('Start', 'manualTrigger'),
    node('Items', 'code', { jsCode: `return ${JSON.stringify(items)}.map((json) => ({ json }));` }),
    node('Send Email', 'sendEmail', parameters, extra),
  ];
  const res = await agent.post('/api/dev/run').send({ name: 'Mail', nodes, connections: chain('Start', 'Items', 'Send Email') });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as RunSummary;
}

describe('Send Email node', () => {
  it('sends a text email and returns the delivery report', async () => {
    await start();
    await saveCredential();
    const run = await send({ fromEmail: 'Shop <shop@example.com>', toEmail: 'bob@example.com', subject: 'Order received', emailFormat: 'text', text: 'Thanks Bob!' });
    expect(run.status).toBe('success');
    expect(smtp.messages).toHaveLength(1);
    const { mail, envelope, user } = smtp.messages[0]!;
    expect(user).toBe(LOGIN.user);
    expect(envelope).toEqual({ from: 'shop@example.com', to: ['bob@example.com'] });
    expect(mail.subject).toBe('Order received');
    expect(mail.from).toMatchObject({ name: 'Shop', address: 'shop@example.com' });
    expect(mail.text?.trim()).toBe('Thanks Bob!');
    expect(mail.html).toBeFalsy();
    expect(run.output[0]![0]).toMatchObject({ accepted: ['bob@example.com'], rejected: [], envelope: { from: 'shop@example.com', to: ['bob@example.com'] } });
    expect(String(run.output[0]![0]!.messageId)).toMatch(/^<.+@.+>$/);
    expect(String(run.output[0]![0]!.response)).toMatch(/^250/);
  });

  it('HTML and "both" formats', async () => {
    await start();
    await saveCredential();
    await send({ toEmail: 'a@example.com', subject: 'H', emailFormat: 'html', html: '<h1>Bonjour <em>Ada</em></h1>' });
    await send({ toEmail: 'a@example.com', subject: 'B', emailFormat: 'both', html: '<p>rich</p>', text: 'plain' });
    const [html, both] = smtp.messages;
    expect(html!.mail.html).toContain('<h1>Bonjour <em>Ada</em></h1>');
    expect(both!.mail.html).toContain('<p>rich</p>');
    expect(both!.mail.text?.trim()).toBe('plain');
    // From falls back to the credential user.
    expect(html!.mail.from?.address).toBe(LOGIN.user);
  });

  it('resolves expressions per item: one email per item, each with its own recipient and subject', async () => {
    await start();
    await saveCredential();
    const run = await send(
      { toEmail: '={{ $json.email }}', subject: '=Hello {{ $json.name }}', emailFormat: 'text', text: '=Your code is {{ $json.code }}' },
      [
        { name: 'Ada', email: 'ada@example.com', code: 111 },
        { name: 'Bob', email: 'bob@example.com', code: 222 },
      ],
    );
    expect(run.status).toBe('success');
    expect(run.output[0]).toHaveLength(2);
    expect(smtp.messages.map((m) => [m.envelope.to[0], m.mail.subject, m.mail.text?.trim()])).toEqual([
      ['ada@example.com', 'Hello Ada', 'Your code is 111'],
      ['bob@example.com', 'Hello Bob', 'Your code is 222'],
    ]);
  });

  it('several recipients, CC, BCC and Reply-To', async () => {
    await start();
    await saveCredential();
    await send({
      toEmail: 'a@example.com, b@example.com',
      subject: 'Team',
      emailFormat: 'text',
      text: 'x',
      options: { ccEmail: 'cc@example.com', bccEmail: 'hidden@example.com', replyTo: 'answers@example.com' },
    });
    const { mail, envelope, raw } = smtp.messages[0]!;
    expect(envelope.to.sort()).toEqual(['a@example.com', 'b@example.com', 'cc@example.com', 'hidden@example.com']);
    expect(mail.to?.map((x) => x.address)).toEqual(['a@example.com', 'b@example.com']);
    expect(mail.cc?.map((x) => x.address)).toEqual(['cc@example.com']);
    expect(mail.replyTo?.map((x) => x.address)).toEqual(['answers@example.com']);
    // BCC recipients get the email but are not written in it.
    expect(raw).not.toContain('hidden@example.com');
  });

  it('designed template: responsive HTML with title, message, button and footer + a text version', async () => {
    await start();
    await saveCredential();
    const run = await send(
      {
        toEmail: 'ada@example.com',
        subject: 'Welcome',
        emailFormat: 'template',
        templateTitle: '=Welcome {{ $json.name }}!',
        templateMessage: 'Thanks for **signing up**.\n\nSee https://example.com/start to begin.',
        templateButtonText: 'Open my account',
        templateButtonUrl: 'https://example.com/account?id=1&x=2',
        templateFooter: 'FlowForge School Project',
        templateColor: '#1d9bf0',
      },
      [{ name: 'Ada <script>' }],
    );
    expect(run.status).toBe('success');
    const { html, text } = smtp.messages[0]!.mail;
    expect(html).toContain('Welcome Ada &lt;script&gt;!');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<strong style="color:#14161f;">signing up</strong>');
    expect(html).toContain('href="https://example.com/start"');
    expect(html).toContain('href="https://example.com/account?id=1&amp;x=2"');
    expect(html).toContain('Open my account');
    expect(html).toContain('FlowForge School Project');
    expect(html).toContain('#1d9bf0');
    expect(text).toContain('Welcome Ada <script>!');
    expect(text).toContain('Open my account: https://example.com/account?id=1&x=2');
  });

  it('per-item errors follow "On Error"', async () => {
    await start();
    await saveCredential();
    const items = [{ email: 'ok@example.com' }, { email: '' }, { email: 'also-ok@example.com' }];
    const params = { toEmail: '={{ $json.email }}', subject: 'S', emailFormat: 'text', text: 'x' };

    const stop = await send(params, items);
    expect(stop.status).toBe('error');
    expect(stop.error).toMatchObject({ message: 'No recipient: "To Email" is empty', node: 'Send Email', itemIndex: 1 });
    expect(smtp.messages).toHaveLength(1);

    const keepGoing = await send(params, items, { onError: 'continueRegularOutput' });
    expect(keepGoing.status).toBe('success');
    expect(keepGoing.output[0]!.map((o) => (o.error ? 'error' : 'sent'))).toEqual(['sent', 'error', 'sent']);
    expect(keepGoing.output[0]![1]).toEqual({ error: 'No recipient: "To Email" is empty' });

    const errorOutput = await send(params, items, { onError: 'continueErrorOutput' });
    expect(errorOutput.status).toBe('success');
    expect(errorOutput.output[0]).toHaveLength(2);
    expect(errorOutput.output[1]).toEqual([{ email: '', error: 'No recipient: "To Email" is empty' }]);
    expect(smtp.messages).toHaveLength(5);
  });
});

describe('Send Email errors', () => {
  it('missing credential: clear error with the type, the .env variable and the docs section', async () => {
    await start();
    const run = await send({ toEmail: 'a@example.com', subject: 'S', emailFormat: 'text', text: 'x' });
    expect(run.status).toBe('error');
    expect(run.error).toMatchObject({
      message: 'SMTP credentials are missing',
      hint: 'Add them on the Credentials page or set SMTP_HOST in .env (see API_SETUP.md#email-smtp).',
      credentialType: 'smtp',
      envVar: 'SMTP_HOST',
      docsAnchor: '#email-smtp',
      node: 'Send Email',
    });
  });

  it('authentication failure: names the credential so the editor can open it', async () => {
    await start();
    const cred = await saveCredential(smtpData(smtp.port, { user: LOGIN.user, pass: 'wrong-password' }));
    const run = await send({ toEmail: 'a@example.com', subject: 'S', emailFormat: 'text', text: 'x' });
    expect(run.status).toBe('error');
    expect(run.error).toMatchObject({
      message: `SMTP authentication failed for "${LOGIN.user}" on 127.0.0.1`,
      credentialType: 'smtp',
      credentialId: cred.id,
    });
    expect(run.error!.hint).toMatch(/Check the user and password/);
    expect(JSON.stringify(run)).not.toContain('wrong-password');
    expect(smtp.messages).toHaveLength(0);
  });

  it('timeout: a server that never answers fails fast with advice', async () => {
    const silent = await startSilentServer();
    try {
      await start();
      await saveCredential({ host: '127.0.0.1', port: silent.port, secure: false });
      const started = Date.now();
      const run = await send({ fromEmail: 'me@example.com', toEmail: 'a@example.com', subject: 'S', emailFormat: 'text', text: 'x', options: { timeout: 1 } });
      expect(run.status).toBe('error');
      expect(run.error!.message).toBe(`Timed out while talking to the SMTP server 127.0.0.1:${silent.port}`);
      expect(run.error!.hint).toMatch(/Port 465 needs "SSL\/TLS" on/);
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      await silent.close();
    }
  });

  it('connection refused and unknown hosts are explained', async () => {
    const s = { host: 'smtp.example.com', port: 587, secure: false, user: 'u', password: 'p' };
    expect(describeSmtpError(Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:587'), { code: 'ESOCKET' }), s)).toMatchObject({ auth: false, message: 'Connection refused by smtp.example.com:587' });
    expect(describeSmtpError(Object.assign(new Error('getaddrinfo ENOTFOUND smtp.example.com'), { code: 'EDNS' }), s).message).toBe('SMTP server "smtp.example.com" not found');
    const gmail = describeSmtpError(Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }), { ...s, host: 'smtp.gmail.com' });
    expect(gmail.auth).toBe(true);
    expect(gmail.hint).toMatch(/App Password/);
    const tls = describeSmtpError(Object.assign(new Error('ssl3_get_record:wrong version number'), { code: 'ESOCKET' }), { ...s, secure: true });
    expect(tls.hint).toBe('Port 587 uses STARTTLS: turn "SSL/TLS" off.');
  });

  it('an empty sender is refused before connecting', async () => {
    await start();
    await saveCredential({ host: '127.0.0.1', port: smtp.port, secure: false });
    const run = await send({ toEmail: 'a@example.com', subject: 'S', emailFormat: 'text', text: 'x' });
    expect(run.error?.message).toBe('No sender: "From Email" is empty');
  });
});

describe('.env fallback', () => {
  it('SMTP_HOST / PORT / SECURE / USER / PASS / FROM are used when no credential is saved', async () => {
    await start({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtp.port),
      SMTP_SECURE: 'false',
      SMTP_USER: LOGIN.user,
      SMTP_PASS: LOGIN.pass,
      SMTP_FROM: 'Env Sender <env@example.com>',
    });
    const run = await send({ toEmail: 'a@example.com', subject: 'From env', emailFormat: 'text', text: 'x' });
    expect(run.status).toBe('success');
    expect(smtp.messages[0]!.user).toBe(LOGIN.user);
    expect(smtp.messages[0]!.mail.from).toMatchObject({ name: 'Env Sender', address: 'env@example.com' });
  });

  it('a wrong SMTP_PASS says that the values come from .env', async () => {
    await start({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false', SMTP_USER: LOGIN.user, SMTP_PASS: 'nope' });
    const run = await send({ toEmail: 'a@example.com', subject: 'S', emailFormat: 'text', text: 'x' });
    expect(run.error).toMatchObject({ credentialType: 'smtp' });
    expect(run.error!.credentialId).toBeUndefined();
    expect(run.error!.hint).toMatch(/The values come from \.env \(SMTP_USER \/ SMTP_PASS\)/);
  });

  it('a saved credential wins over .env', async () => {
    await start({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_SECURE: 'false' });
    await saveCredential();
    const run = await send({ toEmail: 'a@example.com', subject: 'S', emailFormat: 'text', text: 'x' });
    expect(run.status).toBe('success');
    expect(smtp.messages).toHaveLength(1);
  });
});

describe('email template', () => {
  const content = { title: 'Hi', message: 'Line one\nLine two\n\nSecond paragraph', footer: 'Bye' };

  it('uses a table layout with inline styles and a mobile media query', () => {
    const html = renderEmailHtml(content);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(html).toContain('role="presentation"');
    expect(html).toContain('max-width:600px');
    expect(html).toContain('@media only screen and (max-width:620px)');
    expect(html).toContain('Line one<br>Line two');
    expect(html.match(/<p style=/g)).toHaveLength(2);
    expect(html).not.toContain('<a href');
  });

  it('shows the button only with a safe URL, and falls back to the default colour', () => {
    expect(renderEmailHtml({ ...content, buttonText: 'Go', buttonUrl: 'javascript:alert(1)' })).not.toContain('javascript:');
    expect(renderEmailHtml({ ...content, buttonText: 'Go', buttonUrl: 'https://x.test' })).toContain('href="https://x.test"');
    expect(renderEmailHtml({ ...content, buttonText: '', buttonUrl: 'https://x.test' })).not.toContain('href="https://x.test"');
    expect(renderEmailHtml({ ...content, color: 'red;background:url(x)' })).toContain('#f0592a');
    expect(renderEmailText({ ...content, buttonText: 'Go', buttonUrl: 'https://x.test' })).toBe('Hi\n\nLine one\nLine two\n\nSecond paragraph\n\nGo: https://x.test\n\n--\nBye');
  });
});
