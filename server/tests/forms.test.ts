import { inflateSync } from 'node:zlib';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { CredentialSummary, FormFieldDef, JsonObject, WorkflowRecord } from '@flowforge/shared';
import type { AppConfig } from '../src/config.js';
import { makeTestApp, waitFor, type TestApp } from './helpers.js';
import { smtpData, startFakeSmtp, type FakeSmtp } from './smtp-helpers.js';
import { activate, chain, createWorkflow, executions, finished, node, output, signedIn, type Agent } from './trigger-helpers.js';

let t: TestApp;
let agent: Agent;
let smtp: FakeSmtp | undefined;

afterEach(async () => {
  await t?.close();
  await smtp?.close();
  smtp = undefined;
});

async function start(overrides: Partial<AppConfig> = {}) {
  t = await makeTestApp(overrides);
  agent = await signedIn(t);
}

const FIELDS: FormFieldDef[] = [
  { fieldLabel: 'Name', fieldType: 'text', requiredField: true, placeholder: 'Your name' },
  { fieldLabel: 'Email', fieldType: 'email', requiredField: true },
  { fieldLabel: 'Age', fieldType: 'number' },
  { fieldLabel: 'Message', fieldType: 'textarea', helpText: 'Tell us more' },
];

/** Form Trigger → After (No-op), saved and activated. Returns the workflow id. */
async function form(fields: FormFieldDef[] = FIELDS, params: JsonObject = {}, extra: ReturnType<typeof node>[] = [node('After', 'noOp')], name = 'Form') {
  const trigger = node('Form', 'formTrigger', { formTitle: 'Contact us', formFields: { values: fields } as unknown as JsonObject, options: { path: 'contact' }, ...params });
  const nodes = [trigger, ...extra];
  const id = await createWorkflow(agent, { name, nodes, connections: chain(...nodes.map((n) => n.name)) });
  const res = await activate(agent, id);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return id;
}

const submit = (body: Record<string, unknown>, path = '/form/contact') => request(t.app).post(path).type('form').set('Accept', 'application/json').send(body);

/** The single execution of a workflow, finished. */
async function submission(id: string, index = 0) {
  const list = await waitFor(() => (executions(t, id).length > index ? executions(t, id) : undefined), 3000, 'execution');
  return finished(t, list[list.length - 1 - index]!.id);
}

describe('public form page', () => {
  it('GET /form/:path renders a mobile-first page from the field schema', async () => {
    await start();
    await form(FIELDS, { formDescription: 'We answer <fast>', formTheme: 'daylight', options: { path: 'contact', buttonLabel: 'Send it' } });
    const res = await request(t.app).get('/form/contact');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    const html = res.text;
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">');
    expect(html).toContain('<h1>Contact us</h1>');
    expect(html).toContain('We answer &lt;fast&gt;');
    expect(html).toContain('data-theme="daylight"');
    expect(html).toContain('action="/form/contact"');
    expect(html).toContain('<input id="field-0" name="field-0" type="text" value="" placeholder="Your name"');
    expect(html).toContain('type="email"');
    expect(html).toContain('type="number"');
    expect(html).toContain('<textarea id="field-3" name="field-3"');
    expect(html).toContain('Tell us more');
    expect(html).toContain('>Send it</span>');
    expect(html).toContain('Powered by FlowForge');
    // The anti-bot field is in the page but off screen.
    expect(html).toContain('name="website" tabindex="-1"');
    expect(html).not.toContain('Test form');
  });

  it('the production URL needs an active workflow; the page explains it', async () => {
    await start();
    const res = await request(t.app).get('/form/nothing-here');
    expect(res.status).toBe(404);
    expect(res.text).toContain('This form is not available');
    const api = await request(t.app).post('/form/nothing-here').set('Accept', 'application/json').send({});
    expect(api.status).toBe(404);
    expect(api.body).toMatchObject({ ok: false });
  });

  it('form paths and webhook paths are separate; two active forms cannot share a path', async () => {
    await start();
    await form();
    const hook = [node('Webhook', 'webhook', { path: 'contact' })];
    expect((await activate(agent, await createWorkflow(agent, { name: 'Hook', nodes: hook, connections: {} }))).status).toBe(200);
    expect((await request(t.app).get('/webhook/contact')).body).toEqual({ message: 'Workflow was started' });
    expect((await request(t.app).get('/form/contact')).text).toContain('<h1>Contact us</h1>');

    const twin = [node('Form', 'formTrigger', { options: { path: 'contact' } })];
    const refused = await activate(agent, await createWorkflow(agent, { name: 'Twin', nodes: twin, connections: {} }));
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/The form path "contact" \(GET, POST\) is already used by the active workflow "Form"/);
  });
});

describe('submitting', () => {
  it('a valid submission starts an execution; the answers become $json', async () => {
    await start();
    const id = await form();
    const res = await submit({ 'field-0': ' Ada ', 'field-1': 'ada@example.com', 'field-2': '36', 'field-3': 'Hello\nthere' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, title: 'Thank you!', message: 'Your response has been recorded.' });
    const done = await submission(id);
    expect(done.status).toBe('success');
    expect(done.mode).toBe('webhook');
    const json = output(done, 'After')[0]!;
    expect(json).toMatchObject({ Name: 'Ada', Email: 'ada@example.com', Age: 36, Message: 'Hello\nthere', formMode: 'production' });
    expect(Date.parse(String(json.submittedAt))).toBeGreaterThan(Date.now() - 10_000);
    expect(Object.keys(json)).toEqual(['Name', 'Email', 'Age', 'Message', 'submittedAt', 'formMode']);
  });

  it('without JavaScript: a normal POST gets the success page (with confetti)', async () => {
    await start();
    await form(FIELDS, { options: { path: 'contact', successTitle: 'Merci !', successMessage: 'On vous répond vite.' } });
    const res = await request(t.app).post('/form/contact').type('form').send({ 'field-0': 'Ada', 'field-1': 'ada@example.com' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h1>Merci !</h1>');
    expect(res.text).toContain('On vous répond vite.');
    expect(res.text).toContain('data-confetti="1"');
  });

  it('invalid input: 400 with an error per field, and no execution', async () => {
    await start();
    const id = await form();
    const res = await submit({ 'field-0': '  ', 'field-1': 'not-an-email', 'field-2': 'abc' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      ok: false,
      message: 'Please fix the highlighted fields.',
      errors: { 'field-0': 'This field is required', 'field-1': 'Enter a valid email address, like name@example.com', 'field-2': 'Enter a number' },
    });
    expect(executions(t, id)).toHaveLength(0);
  });

  it('invalid input without JavaScript: the form comes back with the errors and what was typed', async () => {
    await start();
    const id = await form();
    const res = await request(t.app).post('/form/contact').type('form').send({ 'field-0': 'Ada "the" <b>', 'field-1': 'nope', 'field-3': 'kept text' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Enter a valid email address');
    expect(res.text).toContain('<div class="field invalid" data-field="field-1">');
    expect(res.text).toContain('value="Ada &quot;the&quot; &lt;b&gt;"');
    expect(res.text).toContain('>kept text</textarea>');
    expect(res.text).toContain('Please fix the highlighted fields.');
    expect(res.text).not.toContain('<b>');
    expect(executions(t, id)).toHaveLength(0);
  });

  it('honeypot: a bot filling the hidden field gets a fake success and starts nothing', async () => {
    await start();
    const id = await form();
    const res = await submit({ 'field-0': 'Bot', 'field-1': 'bot@spam.example', website: 'http://spam.example' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(executions(t, id)).toHaveLength(0);
    // A human (empty honeypot) goes through.
    expect((await submit({ 'field-0': 'Ada', 'field-1': 'ada@example.com', website: '' })).status).toBe(200);
    await waitFor(() => executions(t, id).length === 1, 2000, 'execution');
  });

  it('rate limit on submissions (per IP), not on viewing the form', async () => {
    await start({ formRatePerMinute: 3 });
    await form();
    const ok = { 'field-0': 'Ada', 'field-1': 'ada@example.com' };
    for (let i = 0; i < 3; i++) expect((await submit(ok)).status).toBe(200);
    const blocked = await submit(ok);
    expect(blocked.status).toBe(429);
    expect(blocked.body.ok).toBe(false);
    expect(blocked.body.message).toMatch(/Too many submissions/);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    const page = await request(t.app).post('/form/contact').type('form').send(ok);
    expect(page.status).toBe(429);
    expect(page.text).toContain('Please slow down');
    expect((await request(t.app).get('/form/contact')).status).toBe(200);
  });

  it('size limit: an upload over FORM_MAX_UPLOAD_MB is refused with 413', async () => {
    await start({ formMaxBodyBytes: 200 * 1024 });
    const id = await form([{ fieldLabel: 'CV', fieldType: 'file' }]);
    const big = await request(t.app).post('/form/contact').set('Accept', 'application/json').attach('field-0', Buffer.alloc(400 * 1024, 1), 'big.bin');
    expect(big.status).toBe(413);
    expect(big.body.ok).toBe(false);
    expect(big.body.message).toMatch(/too large/i);
    expect(executions(t, id)).toHaveLength(0);
    const small = await request(t.app).post('/form/contact').set('Accept', 'application/json').attach('field-0', Buffer.alloc(50 * 1024, 1), 'small.bin');
    expect(small.status).toBe(200);
  });
});

describe('field types', () => {
  const ALL: FormFieldDef[] = [
    { fieldLabel: 'Name', fieldType: 'text', requiredField: true },
    { fieldLabel: 'Email', fieldType: 'email', requiredField: true },
    { fieldLabel: 'Guests', fieldType: 'number', requiredField: true },
    { fieldLabel: 'Notes', fieldType: 'textarea' },
    { fieldLabel: 'Meal', fieldType: 'dropdown', requiredField: true, fieldOptions: { values: [{ option: 'Pizza' }, { option: 'Pasta' }] } },
    { fieldLabel: 'Size', fieldType: 'radio', requiredField: true, fieldOptions: { values: [{ option: 'S' }, { option: 'M' }, { option: 'L' }] } },
    { fieldLabel: 'Extras', fieldType: 'checkbox', requiredField: true, fieldOptions: { values: [{ option: 'Cheese' }, { option: 'Olives' }, { option: 'Basil' }] } },
    { fieldLabel: 'I accept the rules', fieldType: 'checkbox', requiredField: true },
    { fieldLabel: 'Day', fieldType: 'date', requiredField: true },
    { fieldLabel: 'Photo', fieldType: 'file', requiredField: true, acceptFileTypes: '.png, image/jpeg' },
    { fieldLabel: 'Source', fieldType: 'hiddenField', fieldName: 'utm_source', fieldValue: 'direct' },
    { fieldLabel: 'PIN', fieldType: 'password' },
  ];
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  it('renders every type', async () => {
    await start();
    await form(ALL);
    const html = (await request(t.app).get('/form/contact?utm_source=qr-code')).text;
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('<select id="field-4" name="field-4"');
    expect(html).toContain('<option value="Pasta">Pasta</option>');
    expect(html).toContain('<input type="radio" name="field-5" value="M"');
    expect(html).toContain('<input type="checkbox" name="field-6" value="Olives"');
    expect(html).toContain('<input type="checkbox" id="field-7" name="field-7" value="true"');
    expect(html).toContain('<input id="field-8" name="field-8" type="date"');
    expect(html).toContain('<input type="file" id="field-9" name="field-9" accept=".png, image/jpeg"');
    // Hidden fields take their value from the URL (?utm_source=…).
    expect(html).toContain('<input type="hidden" name="field-10" value="qr-code">');
    expect(html).toContain('type="password"');
  });

  it('accepts a complete submission and converts each type', async () => {
    await start();
    const id = await form(ALL);
    const res = await request(t.app)
      .post('/form/contact')
      .set('Accept', 'application/json')
      .field('field-0', 'Ada')
      .field('field-1', 'ada@example.com')
      .field('field-2', '3.5')
      .field('field-4', 'Pasta')
      .field('field-5', 'M')
      .field('field-6', 'Cheese')
      .field('field-6', 'Basil')
      .field('field-7', 'true')
      .field('field-8', '2026-12-24')
      .field('field-10', 'qr-code')
      .field('field-11', 's3cret')
      .attach('field-9', PNG, { filename: 'me.png', contentType: 'image/png' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const done = await submission(id);
    expect(output(done, 'After')[0]).toMatchObject({
      Name: 'Ada',
      Email: 'ada@example.com',
      Guests: 3.5,
      Notes: '',
      Meal: 'Pasta',
      Size: 'M',
      Extras: ['Cheese', 'Basil'],
      'I accept the rules': true,
      Day: '2026-12-24',
      Photo: { filename: 'me.png', mimetype: 'image/png', size: PNG.length },
      utm_source: 'qr-code',
      PIN: 's3cret',
    });
    // The uploaded file is binary data of the item.
    const item = done.runData.After![0]!.data.main[0]![0]!;
    expect(item.binary?.Photo).toMatchObject({ fileName: 'me.png', mimeType: 'image/png', fileSize: PNG.length });
    expect((await t.ctx.binaryStore.read(item.binary!.Photo!)).equals(PNG)).toBe(true);
  });

  it('rejects each type with its own message', async () => {
    await start();
    const id = await form(ALL);
    const res = await request(t.app)
      .post('/form/contact')
      .set('Accept', 'application/json')
      .field('field-0', '')
      .field('field-1', 'ada@')
      .field('field-2', 'many')
      .field('field-4', 'Burger')
      .field('field-5', 'XXL')
      .field('field-6', 'Pineapple')
      .field('field-8', '24/12/2026')
      .attach('field-9', Buffer.from('%PDF'), { filename: 'cv.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual({
      'field-0': 'This field is required',
      'field-1': 'Enter a valid email address, like name@example.com',
      'field-2': 'Enter a number',
      'field-4': 'Choose one of the options',
      'field-5': 'Choose one of the options',
      'field-6': 'Choose among the listed options',
      'field-7': 'This box must be checked',
      'field-8': 'Enter a valid date (YYYY-MM-DD)',
      'field-9': '"cv.pdf" is not an accepted file type (.png, image/jpeg)',
    });
    const empty = await request(t.app).post('/form/contact').set('Accept', 'application/json').field('field-0', 'Ada');
    expect(empty.body.errors).toMatchObject({
      'field-4': 'Please choose an option',
      'field-5': 'Please choose an option',
      'field-6': 'Choose at least one option',
      'field-9': 'Please choose a file',
    });
    expect(executions(t, id)).toHaveLength(0);
  });

  it('file uploads: several files, default value and a tampered hidden field', async () => {
    await start();
    const id = await form([
      { fieldLabel: 'Your files', fieldType: 'file', multipleFiles: true },
      { fieldLabel: 'One file', fieldType: 'file' },
      { fieldLabel: 'Plan', fieldType: 'hiddenField', fieldValue: 'free' },
    ]);
    const tooMany = await request(t.app).post('/form/contact').set('Accept', 'application/json').attach('field-1', Buffer.from('a'), 'a.txt').attach('field-1', Buffer.from('b'), 'b.txt');
    expect(tooMany.body.errors).toEqual({ 'field-1': 'Only one file is allowed' });

    const res = await request(t.app).post('/form/contact').set('Accept', 'application/json').attach('field-0', Buffer.from('first'), 'a.txt').attach('field-0', Buffer.from('second!'), 'b.txt');
    expect(res.status).toBe(200);
    const done = await submission(id);
    const item = done.runData.After![0]!.data.main[0]![0]!;
    expect(item.json).toMatchObject({
      'Your files': [
        { filename: 'a.txt', mimetype: 'text/plain', size: 5 },
        { filename: 'b.txt', mimetype: 'text/plain', size: 7 },
      ],
      'One file': null,
      Plan: 'free',
    });
    expect(Object.keys(item.binary ?? {})).toEqual(['Your_files_0', 'Your_files_1']);
    expect((await t.ctx.binaryStore.read(item.binary!.Your_files_1!)).toString()).toBe('second!');
  });
});

describe('confirmation', () => {
  it('"when the workflow finishes": success page after the run, error page when it fails', async () => {
    await start();
    const ok = await form(FIELDS, { responseMode: 'lastNode' }, [node('After', 'noOp')]);
    const res = await submit({ 'field-0': 'Ada', 'field-1': 'ada@example.com' });
    expect(res.body).toMatchObject({ ok: true, title: 'Thank you!' });
    // The execution is already finished when the answer arrives.
    expect(t.ctx.executionsRepo.get(executions(t, ok)[0]!.id)!.status).toBe('success');

    await form(FIELDS, { responseMode: 'lastNode', options: { path: 'broken' } }, [node('Boom', 'stopAndError', { errorMessage: 'Database is down (internal detail)' })], 'Broken');
    const failed = await submit({ 'field-0': 'Ada', 'field-1': 'ada@example.com' }, '/form/broken');
    expect(failed.status).toBe(500);
    expect(failed.body.ok).toBe(false);
    expect(failed.body.message).toMatch(/Something went wrong/);
    // Visitors of the production form never see internal error details.
    expect(JSON.stringify(failed.body)).not.toContain('Database is down');
    const page = await request(t.app).post('/form/broken').type('form').send({ 'field-0': 'Ada', 'field-1': 'ada@example.com' });
    expect(page.status).toBe(500);
    expect(page.text).toContain('Something went wrong');
  });

  it('redirect URL after submission (http/https only)', async () => {
    await start();
    await form(FIELDS, { options: { path: 'contact', redirectUrl: 'https://example.com/thanks' } });
    const ok = { 'field-0': 'Ada', 'field-1': 'ada@example.com' };
    expect((await submit(ok)).body).toMatchObject({ ok: true, redirectUrl: 'https://example.com/thanks' });
    const plain = await request(t.app).post('/form/contact').type('form').send(ok);
    expect(plain.status).toBe(303);
    expect(plain.headers.location).toBe('https://example.com/thanks');

    await form(FIELDS, { options: { path: 'evil', redirectUrl: 'javascript:alert(1)' } }, [node('After', 'noOp')], 'Evil');
    const evil = await submit(ok, '/form/evil');
    expect(evil.body.redirectUrl).toBeUndefined();
    expect(evil.body.ok).toBe(true);
  });
});

describe('test form (/form-test)', () => {
  it('works once while listening, runs in manual mode and shows workflow errors to the builder', async () => {
    await start();
    const nodes = [node('Form', 'formTrigger', { formTitle: 'Try me', responseMode: 'lastNode', options: { path: 'try' } }), node('Boom', 'stopAndError', { errorMessage: 'Custom failure' })];
    const workflow = { name: 'Test form', nodes, connections: chain('Form', 'Boom') };
    const id = await createWorkflow(agent, workflow);

    const idle = await request(t.app).get('/form-test/try');
    expect(idle.status).toBe(404);
    expect(idle.text).toContain('This test form is not listening');

    const listen = await agent.post(`/api/workflows/${id}/test-listen`).send({ workflow, nodeName: 'Form' });
    expect(listen.body).toMatchObject({ kind: 'webhook', testUrl: 'http://ff.test/form-test/try', method: 'GET, POST' });
    // Forms are filled by people: the listener stays open 5 minutes.
    expect(Date.parse(listen.body.expiresAt) - Date.now()).toBeGreaterThan(200_000);

    // Opening (and re-opening) the page does not use up the listener.
    for (let i = 0; i < 2; i++) {
      const page = await request(t.app).get('/form-test/try');
      expect(page.status).toBe(200);
      expect(page.text).toContain('Test form: submitting it runs the workflow in the editor.');
      expect(page.text).toContain('action="/form-test/try"');
    }
    // Neither does an invalid submission.
    expect((await submit({ 'field-1': 'bad' }, '/form-test/try')).status).toBe(400);

    const res = await submit({ 'field-0': 'Ada', 'field-1': 'ada@example.com' }, '/form-test/try');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Something went wrong. The workflow failed: Custom failure');
    const done = await finished(t, executions(t, id)[0]!.id);
    expect(done.mode).toBe('manual');
    expect(output(done, 'Form')[0]).toMatchObject({ Name: 'Ada', formMode: 'test' });
    expect((await request(t.app).get('/form-test/try')).status).toBe(404); // single shot
    expect((await request(t.app).get('/form/try')).status).toBe(404); // not active
  });
});

describe('QR code', () => {
  /** Validates the PNG structure and returns its size (IHDR). */
  function readPng(buffer: Buffer) {
    expect(buffer.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const chunks: { type: string; data: Buffer }[] = [];
    for (let offset = 8; offset < buffer.length; ) {
      const length = buffer.readUInt32BE(offset);
      chunks.push({ type: buffer.toString('ascii', offset + 4, offset + 8), data: buffer.subarray(offset + 8, offset + 8 + length) });
      offset += 12 + length;
    }
    expect(chunks[0]!.type).toBe('IHDR');
    expect(chunks[chunks.length - 1]!.type).toBe('IEND');
    const pixels = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
    expect(pixels.length).toBeGreaterThan(1000);
    return { width: chunks[0]!.data.readUInt32BE(0), height: chunks[0]!.data.readUInt32BE(4) };
  }
  const binary = (req: request.Test) =>
    req.buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });

  it('GET /api/qr returns a valid PNG generated locally', async () => {
    await start();
    const url = 'http://192.168.1.20:5679/form/contact';
    const res = await binary(agent.get(`/api/qr?text=${encodeURIComponent(url)}`));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    const { width, height } = readPng(res.body as Buffer);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(480);

    const large = await binary(agent.get(`/api/qr?size=1024&download=contact-form&text=${encodeURIComponent(url)}`));
    expect(readPng(large.body as Buffer).width).toBeGreaterThanOrEqual(1000);
    expect(large.headers['content-disposition']).toBe('attachment; filename=contact-form.png');
    // Different text, different code.
    const other = await binary(agent.get('/api/qr?text=hello'));
    expect((other.body as Buffer).equals(res.body as Buffer)).toBe(false);
  });

  it('needs a session and a reasonable text', async () => {
    await start();
    expect((await request(t.app).get('/api/qr?text=x')).status).toBe(401);
    expect((await agent.get('/api/qr')).status).toBe(400);
    expect((await agent.get(`/api/qr?text=${'x'.repeat(2500)}`)).status).toBe(400);
    expect((await agent.get('/api/qr?text=x&size=5')).status).toBe(400);
  });

  it('system info tells the editor which URL phones can reach', async () => {
    await start({ publicUrl: 'http://192.168.1.20:5679', publicUrlSource: 'lan' });
    expect((await agent.get('/api/system/info')).body).toMatchObject({ publicUrl: 'http://192.168.1.20:5679', publicUrlSource: 'lan', port: 5679 });
  });
});

describe('Wait node form', () => {
  it('uses the same builder fields: uploads become binary data of the resumed item', async () => {
    const { waitLimits } = await import('../src/nodes/flow/wait.node.js');
    const before = waitLimits.inMemoryMaxMs;
    waitLimits.inMemoryMaxMs = 0;
    try {
      await start();
      const formFields = { values: [{ fieldLabel: 'Approve', fieldType: 'radio', requiredField: true, fieldOptions: { values: [{ option: 'Yes' }, { option: 'No' }] } }, { fieldLabel: 'Proof', fieldType: 'file' }] };
      const nodes = [node('Start', 'manualTrigger'), node('Wait', 'wait', { resume: 'form', formTitle: 'Approval', formTheme: 'sunset', formFields }), node('After', 'noOp')];
      const run = await agent.post('/api/dev/run?wait=false').send({ name: 'Approval', nodes, connections: chain('Start', 'Wait', 'After') });
      const id = String(run.body.executionId);
      await waitFor(() => t.ctx.executionsRepo.get(id)?.status === 'waiting', 3000, 'waiting');

      const page = await request(t.app).get(`/form-waiting/${id}`);
      expect(page.text).toContain('data-theme="sunset"');
      expect(page.text).toContain('<input type="radio" name="field-0" value="Yes"');
      const invalid = await request(t.app).post(`/form-waiting/${id}`).set('Accept', 'application/json').field('field-0', 'Maybe');
      expect(invalid.status).toBe(400);
      expect(invalid.body.errors).toEqual({ 'field-0': 'Choose one of the options' });

      const ok = await request(t.app).post(`/form-waiting/${id}`).set('Accept', 'application/json').field('field-0', 'Yes').attach('field-1', Buffer.from('signed'), 'proof.txt');
      expect(ok.body).toMatchObject({ ok: true, title: 'Approval' });
      const done = await finished(t, id);
      const item = done.runData.After![0]!.data.main[0]![0]!;
      expect(item.json).toMatchObject({ Approve: 'Yes', Proof: { filename: 'proof.txt', size: 6 } });
      expect((await t.ctx.binaryStore.read(item.binary!.Proof!)).toString()).toBe('signed');
      expect((await request(t.app).get(`/form-waiting/${id}`)).status).toBe(404);
    } finally {
      waitLimits.inMemoryMaxMs = before;
    }
  });
});

describe('example: contact form → emails', () => {
  const LOGIN = { user: 'shop@flowforge.test', pass: 'app-password' };

  it('is listed and imported from /examples, then sends both emails and confirms', async () => {
    smtp = await startFakeSmtp(LOGIN);
    await start();
    const list = (await agent.get('/api/examples')).body as { id: string; name: string; description: string; nodeCount: number }[];
    expect(list).toContainEqual(expect.objectContaining({ id: 'form-to-email', name: 'Contact form → emails', nodeCount: 3 }));
    expect(list.find((e) => e.id === 'form-to-email')!.description).toMatch(/confirmation/);

    const imported = await agent.post('/api/examples/form-to-email/import');
    expect(imported.status).toBe(201);
    const wf = imported.body as WorkflowRecord;
    const again = (await agent.post('/api/examples/form-to-email/import')).body as WorkflowRecord;
    expect(again.name).toBe('Contact form → emails 2');
    const trigger = wf.nodes.find((n) => n.type === 'flowforge.formTrigger')!;
    // Every import gets its own form URL.
    expect(trigger.webhookId).not.toBe(again.nodes.find((n) => n.type === 'flowforge.formTrigger')!.webhookId);
    expect((await agent.post('/api/examples/..%2Fpackage/import')).status).toBe(404);

    // Without SMTP the form answers with a clear failure (test mode would show the reason).
    expect((await activate(agent, wf.id)).status).toBe(200);
    const fill = { 'field-0': 'Ada Lovelace', 'field-1': 'ada@example.com', 'field-2': 'Feedback', 'field-3': 'Great tool!\nSecond line.' };
    const noSmtp = await submit(fill, `/form/${trigger.webhookId}`);
    expect(noSmtp.status).toBe(500);
    const failed = await finished(t, executions(t, wf.id)[0]!.id);
    expect(failed.error).toMatchObject({ credentialType: 'smtp', node: 'Notify admin' });

    // With a default SMTP credential nothing has to be selected on the nodes.
    const cred = (await agent.post('/api/credentials').send({ name: 'Shop mail', type: 'smtp', data: smtpData(smtp.port, LOGIN) })).body as CredentialSummary;
    expect(cred.isDefault).toBe(true);
    const res = await submit(fill, `/form/${trigger.webhookId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ok: true, title: 'Message sent!', message: 'Thank you. A confirmation email is on its way to your inbox.' });

    expect(smtp.messages).toHaveLength(2);
    const admin = smtp.messages.find((m) => m.envelope.to.includes('admin@example.com'))!;
    const confirmation = smtp.messages.find((m) => m.envelope.to.includes('ada@example.com'))!;
    expect(admin.mail.subject).toBe('New message from Ada Lovelace (Feedback)');
    expect(admin.mail.replyTo?.[0]?.address).toBe('ada@example.com');
    expect(admin.mail.html).toContain('New message from Ada Lovelace');
    expect(admin.mail.html).toContain('Great tool!<br>Second line.');
    expect(admin.mail.html).toContain('href="mailto:ada@example.com"');
    expect(confirmation.mail.subject).toBe('We received your message');
    expect(confirmation.mail.html).toContain('Thanks, Ada Lovelace!');
    expect(confirmation.mail.text).toContain('Great tool!');
    expect(confirmation.mail.from?.address).toBe(LOGIN.user);

    const done = await finished(t, executions(t, wf.id)[0]!.id);
    expect(done.status).toBe('success');
    expect(Object.keys(done.runData).sort()).toEqual(['Contact form', 'Notify admin', 'Send confirmation']);
  });

  it('a file uploaded in a form can be attached to the email', async () => {
    smtp = await startFakeSmtp(LOGIN);
    await start();
    await agent.post('/api/credentials').send({ name: 'Shop mail', type: 'smtp', data: smtpData(smtp.port, LOGIN) });
    const fields: FormFieldDef[] = [
      { fieldLabel: 'Email', fieldType: 'email', requiredField: true },
      { fieldLabel: 'Your CV', fieldType: 'file', requiredField: true },
    ];
    const mail = node('Mail', 'sendEmail', { toEmail: 'hr@example.com', subject: '=CV from {{ $json.Email }}', emailFormat: 'text', text: 'See attachment', options: { attachments: 'Your_CV' } });
    await form(fields, { responseMode: 'lastNode' }, [mail]);
    const pdf = Buffer.from('%PDF-1.4 fake pdf content éè binary \x00\x01\x02');
    const res = await request(t.app).post('/form/contact').set('Accept', 'application/json').field('field-0', 'ada@example.com').attach('field-1', pdf, { filename: 'ada-cv.pdf', contentType: 'application/pdf' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(smtp.messages).toHaveLength(1);
    const { mail: received } = smtp.messages[0]!;
    expect(received.subject).toBe('CV from ada@example.com');
    expect(received.attachments).toHaveLength(1);
    expect(received.attachments[0]).toMatchObject({ filename: 'ada-cv.pdf', mimeType: 'application/pdf' });
    expect(Buffer.from(received.attachments[0]!.content as ArrayBuffer).equals(pdf)).toBe(true);

    // A wrong property name is a clear error.
    const wrong = node('Mail', 'sendEmail', { toEmail: 'hr@example.com', subject: 'x', emailFormat: 'text', text: 'x', options: { attachments: 'nope' } });
    const id = await form(fields, { responseMode: 'lastNode', options: { path: 'wrong' } }, [wrong], 'Wrong');
    await request(t.app).post('/form/wrong').set('Accept', 'application/json').field('field-0', 'ada@example.com').attach('field-1', pdf, 'cv.pdf');
    const failed = await finished(t, executions(t, id)[0]!.id);
    expect(failed.error).toMatchObject({ message: 'Item 0 has no binary property "nope" to attach', hint: 'Binary properties of this item: Your_CV. Use their names, separated by commas.' });
  });
});
