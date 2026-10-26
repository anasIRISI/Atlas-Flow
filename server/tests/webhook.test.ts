import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@flowforge/shared';
import { makeTestApp, waitFor, type TestApp } from './helpers.js';
import { activate, chain, createWorkflow, executions, finished, node, output, signedIn, type Agent } from './trigger-helpers.js';

let t: TestApp;
let agent: Agent;

beforeEach(async () => {
  t = await makeTestApp();
  agent = await signedIn(t);
});
afterEach(async () => {
  await t.close();
});

/** Webhook → Reply (Edit Fields) [→ extra nodes], saved and activated. */
async function webhookWorkflow(params: JsonObject, extra: ReturnType<typeof node>[] = [], name = 'Hook') {
  const nodes = [
    node('Webhook', 'webhook', { path: 'hello', ...params }),
    node('Reply', 'set', {
      includeOtherFields: false,
      assignments: { assignments: [{ name: 'greeting', value: '=Hi {{ $json.body.name ?? $json.query.name ?? "there" }}', type: 'string' }] },
    }),
    ...extra,
  ];
  const id = await createWorkflow(agent, { name, nodes, connections: chain(...nodes.map((n) => n.name)) });
  const res = await activate(agent, id);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return id;
}

describe('production webhooks', () => {
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])('%s works when the method matches', async (method) => {
    const id = await webhookWorkflow({ httpMethod: method });
    const res = await request(t.app)[method.toLowerCase() as 'get']('/webhook/hello?name=Ada');
    expect(res.status).toBe(200);
    if (method !== 'HEAD') expect(res.body).toEqual({ message: 'Workflow was started' });
    const [execution] = executions(t, id);
    const done = await finished(t, execution!.id);
    expect(done.mode).toBe('webhook');
    expect(output(done, 'Webhook')[0]).toMatchObject({ query: { name: 'Ada' }, webhookUrl: 'http://ff.test/webhook/hello', executionMode: 'production' });
  });

  it('answers 405 for another method and 404 when not registered', async () => {
    await webhookWorkflow({ httpMethod: 'POST' });
    const wrong = await request(t.app).get('/webhook/hello');
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe('POST');
    const missing = await request(t.app).get('/webhook/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe('The requested webhook "GET nope" is not registered.');
    expect(missing.body.hint).toMatch(/Activate the workflow/);
  });

  it('stops answering when the workflow is deactivated or deleted', async () => {
    const id = await webhookWorkflow({ httpMethod: 'GET' });
    expect((await request(t.app).get('/webhook/hello')).status).toBe(200);
    await agent.post(`/api/workflows/${id}/deactivate`);
    expect((await request(t.app).get('/webhook/hello')).status).toBe(404);
    await activate(agent, id);
    await agent.delete(`/api/workflows/${id}`);
    expect((await request(t.app).get('/webhook/hello')).status).toBe(404);
    expect(t.webhookRegistry.count()).toBe(0);
  });

  it('supports dynamic paths; static paths win', async () => {
    await webhookWorkflow({ path: 'users/:id' }, [], 'Dynamic');
    const staticId = await webhookWorkflow({ path: 'users/me' }, [], 'Static');
    await request(t.app).get('/webhook/users/42').expect(200);
    await request(t.app).get('/webhook/users/me').expect(200);
    const dyn = await finished(t, executions(t).find((e) => e.workflowName === 'Dynamic')!.id);
    expect(output(dyn, 'Webhook')[0]!.params).toEqual({ id: '42' });
    expect(executions(t, staticId)).toHaveLength(1);
  });

  it('refuses a second active workflow on the same method + path', async () => {
    await webhookWorkflow({ httpMethod: 'POST' }, [], 'First');
    const nodes = [node('Webhook', 'webhook', { path: '/hello/', httpMethod: 'POST' })];
    const second = await createWorkflow(agent, { name: 'Second', nodes, connections: {} });
    const res = await activate(agent, second);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Webhook: The webhook path "hello" (POST) is already used by the active workflow "First"');
    const stored = (await agent.get(`/api/workflows/${second}`)).body;
    expect(stored).toMatchObject({ active: false, activationError: expect.stringContaining('already used') });
    // Another method on the same path is fine.
    const third = await createWorkflow(agent, { name: 'Third', nodes: [node('Webhook', 'webhook', { path: 'hello', httpMethod: 'GET' })], connections: {} });
    expect((await activate(agent, third)).status).toBe(200);
  });

  it('rejects invalid paths at activation', async () => {
    const id = await createWorkflow(agent, { name: 'Bad', nodes: [node('Webhook', 'webhook', { path: 'hé llo' })], connections: {} });
    const res = await activate(agent, id);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Invalid character in webhook path/);
  });
});

describe('test URL ("Listen for test event")', () => {
  it('works once while listening, runs in manual mode, and can be canceled', async () => {
    const nodes = [node('Webhook', 'webhook', { path: 'try', httpMethod: 'POST' }), node('Next', 'noOp')];
    const workflow = { name: 'Test URL', nodes, connections: chain('Webhook', 'Next') };
    const id = await createWorkflow(agent, workflow);
    expect((await request(t.app).post('/webhook-test/try')).status).toBe(404);
    const listen = await agent.post(`/api/workflows/${id}/test-listen`).send({ workflow, nodeName: 'Webhook' });
    expect(listen.body).toMatchObject({ kind: 'webhook', testUrl: 'http://ff.test/webhook-test/try', method: 'POST' });
    expect((await request(t.app).post('/webhook/try')).status).toBe(404); // production URL needs activation
    const res = await request(t.app).post('/webhook-test/try').send({ hi: 1 });
    expect(res.status).toBe(200);
    const done = await finished(t, executions(t, id)[0]!.id);
    expect(done.mode).toBe('manual');
    expect(output(done, 'Next')[0]).toMatchObject({ body: { hi: 1 }, executionMode: 'test' });
    expect((await request(t.app).post('/webhook-test/try')).status).toBe(404); // single shot

    await agent.post(`/api/workflows/${id}/test-listen`).send({ workflow, nodeName: 'Webhook' });
    expect((await agent.delete(`/api/workflows/${id}/test-listen`)).body).toEqual({ stopped: true });
    expect((await request(t.app).post('/webhook-test/try')).status).toBe(404);
  });
});

describe('response modes', () => {
  it('Immediately: custom status code, body and headers', async () => {
    await webhookWorkflow({ options: { responseCode: 201, responseBody: '{"ok":true}', responseHeaders: [{ name: 'X-Flow', value: 'forge' }] } });
    const res = await request(t.app).get('/webhook/hello');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['x-flow']).toBe('forge');
    await webhookWorkflow({ path: 'text', options: { responseBody: 'thanks!' } }, [], 'Text');
    expect((await request(t.app).get('/webhook/text')).text).toBe('thanks!');
    // Expressions work in webhook settings ($workflow, $now… — no item data yet).
    await webhookWorkflow({ path: 'expr', options: { responseBody: '={"from": "{{ $workflow.name }}", "year": {{ $now.year }}}' } }, [], 'Expr');
    expect((await request(t.app).get('/webhook/expr')).body).toEqual({ from: 'Expr', year: new Date().getFullYear() });
  });

  it('When last node finishes: first entry JSON, all entries, no data, first binary', async () => {
    await webhookWorkflow({ path: 'first', httpMethod: 'POST', responseMode: 'lastNode' }, [], 'First');
    const first = await request(t.app).post('/webhook/first').send({ name: 'Ada' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ greeting: 'Hi Ada' });

    const split = node('Split', 'code', { jsCode: 'return [{ json: { n: 1 } }, { json: { n: 2 } }];' });
    await webhookWorkflow({ path: 'all', responseMode: 'lastNode', responseData: 'allEntries', options: { responseCode: 202 } }, [split], 'All');
    const all = await request(t.app).get('/webhook/all');
    expect(all.status).toBe(202);
    expect(all.body).toEqual([{ n: 1 }, { n: 2 }]);

    await webhookWorkflow({ path: 'none', responseMode: 'lastNode', responseData: 'noData' }, [], 'None');
    const none = await request(t.app).get('/webhook/none');
    expect(none.status).toBe(200);
    expect(none.text).toBe('');

    await webhookWorkflow({ path: 'file', responseMode: 'lastNode', responseData: 'firstEntryBinary' }, [node('Make', 'test.makeFile')], 'File');
    const file = await request(t.app).get('/webhook/file');
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/text\/csv/);
    expect(file.text).toBe('a,b\n1,2');
  });

  it('When last node finishes: a failing workflow answers 500 with the error', async () => {
    await webhookWorkflow({ path: 'boom', responseMode: 'lastNode' }, [node('Boom', 'stopAndError', { errorMessage: 'Out of stock' })], 'Boom');
    const res = await request(t.app).get('/webhook/boom');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ message: 'Error in workflow', error: 'Out of stock', node: 'Boom' });
  });

  const respond = (params: JsonObject) => node('Respond', 'respondToWebhook', params);

  it.each<[string, JsonObject, (res: request.Response) => void]>([
    ['all incoming items', { respondWith: 'allIncomingItems' }, (r) => expect(r.body).toEqual([{ greeting: 'Hi Ada' }])],
    ['first incoming item', { respondWith: 'firstIncomingItem' }, (r) => expect(r.body).toEqual({ greeting: 'Hi Ada' })],
    ['JSON (expression)', { respondWith: 'json', responseBody: '={ "said": "{{ $json.greeting }}" }' }, (r) => expect(r.body).toEqual({ said: 'Hi Ada' })],
    ['text', { respondWith: 'text', responseText: '=Plain {{ $json.greeting }}' }, (r) => expect(r.text).toBe('Plain Hi Ada')],
    ['no data, custom code and header', { respondWith: 'noData', options: { responseCode: 204, responseHeaders: [{ name: 'X-Done', value: 'yes' }] } }, (r) => {
      expect(r.status).toBe(204);
      expect(r.headers['x-done']).toBe('yes');
    }],
    ['redirect', { respondWith: 'redirect', redirectURL: 'https://example.com/thanks' }, (r) => {
      expect(r.status).toBe(307);
      expect(r.headers.location).toBe('https://example.com/thanks');
    }],
  ])('Respond to Webhook: %s', async (_label, params, check) => {
    await webhookWorkflow({ httpMethod: 'POST', responseMode: 'responseNode' }, [respond(params)]);
    const res = await request(t.app).post('/webhook/hello').send({ name: 'Ada' }).redirects(0);
    if (!('options' in params)) expect([200, 307]).toContain(res.status);
    check(res);
  });

  it('Respond to Webhook: binary file', async () => {
    await webhookWorkflow({ responseMode: 'responseNode' }, [node('Make', 'test.makeFile'), respond({ respondWith: 'binary' })]);
    const res = await request(t.app).get('/webhook/hello');
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toBe('a,b\n1,2');
  });

  it('Respond to Webhook: the caller gets the answer before the workflow ends', async () => {
    await webhookWorkflow({ responseMode: 'responseNode' }, [respond({ respondWith: 'text', responseText: 'early' }), node('Slow', 'test.slow', { ms: 600 })]);
    const started = Date.now();
    const res = await request(t.app).get('/webhook/hello');
    expect(res.text).toBe('early');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('no Respond to Webhook node executed → clear 500', async () => {
    await webhookWorkflow({ responseMode: 'responseNode' });
    const res = await request(t.app).get('/webhook/hello');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('No "Respond to Webhook" node was executed');
    expect(res.body.hint).toMatch(/Respond to Webhook/);
  });
});

describe('authentication (credentials)', () => {
  it('basic auth: activation needs the credential; then missing 401, wrong 403, right 200', async () => {
    const nodes = [node('Webhook', 'webhook', { path: 'hello', authentication: 'basicAuth' })];
    const id = await createWorkflow(agent, { name: 'Locked', nodes, connections: {} });
    const refused = await activate(agent, id);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe('Webhook: Basic Auth credentials are missing');

    const created = await agent.post('/api/credentials').send({ name: 'Hook login', type: 'httpBasicAuth', data: { user: 'ada', password: 's3cret' } });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain('s3cret');
    expect((await activate(agent, id)).status).toBe(200);

    const missing = await request(t.app).get('/webhook/hello');
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toMatch(/Basic/);
    expect((await request(t.app).get('/webhook/hello').auth('ada', 'nope')).status).toBe(403);
    expect((await request(t.app).get('/webhook/hello').auth('ada', 's3cret').set('X-Trace', 'kept')).status).toBe(200);
    // The Authorization header that was checked is not stored with the execution; other headers are.
    const done = await finished(t, executions(t, id)[0]!.id);
    expect(output(done, 'Webhook')[0]!.headers).toMatchObject({ authorization: '**hidden**', 'x-trace': 'kept' });
    expect(JSON.stringify(done)).not.toContain(Buffer.from('ada:s3cret').toString('base64'));
  });

  it('header auth uses the credential selected on the node', async () => {
    const other = await agent.post('/api/credentials').send({ name: 'Default key', type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: 'default' } });
    const chosen = await agent.post('/api/credentials').send({ name: 'Partner key', type: 'httpHeaderAuth', data: { name: 'X-Api-Key', value: 'k-123' } });
    expect(other.body.isDefault).toBe(true);
    expect(chosen.body.isDefault).toBe(false);
    const nodes = [{ ...node('Webhook', 'webhook', { path: 'hello', authentication: 'headerAuth' }), credentials: { httpHeaderAuth: { id: chosen.body.id, name: 'Partner key' } } }];
    const id = await createWorkflow(agent, { name: 'Header', nodes, connections: {} });
    expect((await activate(agent, id)).status).toBe(200);
    expect((await request(t.app).get('/webhook/hello')).status).toBe(401);
    expect((await request(t.app).get('/webhook/hello').set('X-Api-Key', 'default')).status).toBe(403);
    expect((await request(t.app).get('/webhook/hello').set('X-Api-Key', 'k-123').set('Authorization', 'Bearer app-data')).status).toBe(200);
    const done = await finished(t, executions(t, id)[0]!.id);
    // Only the header used for authentication is hidden: an Authorization header is ordinary data here.
    expect(output(done, 'Webhook')[0]!.headers).toMatchObject({ 'x-api-key': '**hidden**', authorization: 'Bearer app-data' });
    expect(JSON.stringify(done)).not.toContain('k-123');
  });

  it('the session cookie of a signed-in caller never reaches the workflow', async () => {
    const id = await webhookWorkflow({});
    // The owner tries the webhook from the browser they are signed in with.
    const res = await agent.get('/webhook/hello').set('Cookie', 'theme=dark');
    expect(res.status).toBe(200);
    const headers = output(await finished(t, executions(t, id)[0]!.id), 'Webhook')[0]!.headers as Record<string, string>;
    expect(headers.cookie).toBe('theme=dark');
    expect(JSON.stringify(headers)).not.toContain('ff_session');
    // Only the session cookie: nothing is left of the header.
    await request(t.app).get('/webhook/hello').set('Cookie', 'ff_session=abc123');
    const second = output(await finished(t, executions(t, id)[0]!.id), 'Webhook')[0]!.headers as Record<string, string>;
    expect(second.cookie).toBeUndefined();
  });

  it('without authentication every header is passed to the workflow', async () => {
    const id = await webhookWorkflow({});
    await request(t.app).get('/webhook/hello').set('Authorization', 'Bearer my-own-check');
    expect(output(await finished(t, executions(t, id)[0]!.id), 'Webhook')[0]!.headers).toMatchObject({ authorization: 'Bearer my-own-check' });
  });
});

describe('request bodies', () => {
  const body = async (send: (r: request.Test) => request.Test) => {
    const id = await webhookWorkflow({ httpMethod: 'POST' });
    const res = await send(request(t.app).post('/webhook/hello'));
    expect(res.status).toBe(200);
    return output(await finished(t, executions(t, id)[0]!.id), 'Webhook')[0]!;
  };

  it('JSON', async () => {
    expect((await body((r) => r.send({ a: [1, 2] }))).body).toEqual({ a: [1, 2] });
  });

  it('form urlencoded (repeated keys become lists)', async () => {
    expect((await body((r) => r.type('form').send('name=Ada&tag=a&tag=b'))).body).toEqual({ name: 'Ada', tag: ['a', 'b'] });
  });

  it('text', async () => {
    expect((await body((r) => r.set('Content-Type', 'text/plain').send('hello world'))).body).toBe('hello world');
  });

  it('raw bytes become binary data', async () => {
    const id = await webhookWorkflow({ httpMethod: 'POST' });
    await request(t.app).post('/webhook/hello').set('Content-Type', 'image/png').send(Buffer.from([137, 80, 78, 71])).expect(200);
    const done = await finished(t, executions(t, id)[0]!.id);
    const item = done.runData.Webhook![0]!.data.main[0]![0]!;
    expect(item.binary?.data).toMatchObject({ mimeType: 'image/png', fileSize: 4 });
  });

  it('multipart: fields and files', async () => {
    const id = await webhookWorkflow({ httpMethod: 'POST' });
    await request(t.app).post('/webhook/hello').field('name', 'Ada').attach('cv', Buffer.from('my cv'), 'cv.txt').expect(200);
    const done = await finished(t, executions(t, id)[0]!.id);
    const item = done.runData.Webhook![0]!.data.main[0]![0]!;
    expect(item.json.body).toEqual({ name: 'Ada' });
    expect(item.binary?.cv).toMatchObject({ fileName: 'cv.txt', fileSize: 5 });
    expect(output(done, 'Reply')[0]).toEqual({ greeting: 'Hi Ada' });
  });

  it('invalid JSON → 400, too large → 413', async () => {
    await t.close();
    t = await makeTestApp({ webhookMaxBodyBytes: 1024 });
    agent = await signedIn(t);
    await webhookWorkflow({ httpMethod: 'POST' });
    const bad = await request(t.app).post('/webhook/hello').set('Content-Type', 'application/json').send('{"a":');
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe('The request body is not valid JSON');
    const big = await request(t.app).post('/webhook/hello').send({ x: 'y'.repeat(5000) });
    expect(big.status).toBe(413);
  });
});

describe('safety', () => {
  it('CORS preflight and headers', async () => {
    await webhookWorkflow({ httpMethod: 'POST', options: { allowedOrigins: 'https://site.example' } });
    const pre = await request(t.app)
      .options('/webhook/hello')
      .set('Origin', 'https://site.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('https://site.example');
    expect(pre.headers['access-control-allow-methods']).toBe('POST, OPTIONS');
    const res = await request(t.app).post('/webhook/hello').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rate-limits public routes per client', async () => {
    await t.close();
    t = await makeTestApp({ webhookRatePerMinute: 3 });
    agent = await signedIn(t);
    await webhookWorkflow({});
    for (let i = 0; i < 3; i++) expect((await request(t.app).get('/webhook/hello')).status).toBe(200);
    const limited = await request(t.app).get('/webhook/hello');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('never crashes on garbage paths', async () => {
    expect((await request(t.app).get('/webhook/%E0%A4%A')).status).toBe(400);
    expect((await request(t.app).get(`/webhook/${'a/'.repeat(300)}`)).status).toBe(404);
    await waitFor(() => true);
  });
});
