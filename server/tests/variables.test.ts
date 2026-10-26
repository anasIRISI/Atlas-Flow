import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from './helpers.js';
import { chain, node, signedIn, type Agent } from './trigger-helpers.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const make = async (agent: Agent, key: string, value: string) => (await agent.post('/api/variables').send({ key, value })).body as { id: string; key: string; value: string };

const runNodes = async (agent: Agent, nodes: ReturnType<typeof node>[]) =>
  (await agent.post('/api/dev/run').send({ name: 'W', nodes, connections: chain(...nodes.map((n) => n.name)) })).body as {
    status: string;
    output: Array<Array<Record<string, unknown>>>;
    error?: { message: string };
  };

describe('variables API', () => {
  it('needs a session on every route', async () => {
    t = await makeTestApp();
    expect((await request(t.app).get('/api/variables')).status).toBe(401);
    expect((await request(t.app).post('/api/variables').send({ key: 'a', value: 'b' })).status).toBe(401);
    expect((await request(t.app).patch('/api/variables/x').send({ value: 'b' })).status).toBe(401);
    expect((await request(t.app).delete('/api/variables/x')).status).toBe(401);
  });

  it('creates, lists (sorted), edits and deletes', async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    expect((await agent.get('/api/variables')).body).toEqual([]);
    const b = await make(agent, 'beta', '2');
    await make(agent, 'alpha', '1');
    expect((await agent.get('/api/variables')).body.map((v: { key: string }) => v.key)).toEqual(['alpha', 'beta']);
    const patched = await agent.patch(`/api/variables/${b.id}`).send({ key: 'gamma', value: 'x'.repeat(10_000) });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ id: b.id, key: 'gamma' });
    expect((await agent.delete(`/api/variables/${b.id}`)).status).toBe(204);
    expect((await agent.delete(`/api/variables/${b.id}`)).status).toBe(404);
    expect((await agent.patch(`/api/variables/${b.id}`).send({ value: 'z' })).status).toBe(404);
  });

  it('rejects bad input and duplicates', async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    for (const key of ['', '1abc', 'has space', 'dash-ed', 'a'.repeat(65)]) {
      expect((await agent.post('/api/variables').send({ key, value: 'v' })).status, key).toBe(400);
    }
    expect((await agent.post('/api/variables').send({ key: 'ok', value: 'x'.repeat(10_001) })).status).toBe(400);
    expect((await agent.post('/api/variables').send({ key: 'ok' })).status).toBe(400);
    expect((await agent.post('/api/variables').send({ key: 'ok', value: 'v', extra: 1 })).status).toBe(400);
    const one = await make(agent, 'dup', '1');
    const two = await make(agent, 'other', '2');
    expect((await agent.post('/api/variables').send({ key: 'dup', value: '3' })).status).toBe(409);
    expect((await agent.patch(`/api/variables/${two.id}`).send({ key: 'dup' })).status).toBe(409);
    expect((await agent.patch(`/api/variables/${one.id}`).send({ key: 'dup', value: 'same key ok' })).status).toBe(200);
    expect((await agent.patch(`/api/variables/${one.id}`).send({ key: 'bad key' })).status).toBe(400);
  });
});

describe('$vars at run time', () => {
  it('works in an expression of a real run, and follows edits', async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const v = await make(agent, 'city', 'Paris');
    const nodes = [node('Start', 'manualTrigger'), node('Set', 'set', { assignments: { assignments: [{ name: 'c', value: '=Hello {{ $vars.city }}', type: 'string' }] } })];
    expect((await runNodes(agent, nodes)).output[0]![0]).toEqual({ c: 'Hello Paris' });
    await agent.patch(`/api/variables/${v.id}`).send({ value: 'Rome' });
    expect((await runNodes(agent, nodes)).output[0]![0]).toEqual({ c: 'Hello Rome' });
  });

  it('works in the expression preview', async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    await make(agent, 'city', 'Oslo');
    const res = await agent.post('/api/expressions/preview').send({ expression: '={{ $vars.city }}' });
    expect(res.body).toMatchObject({ ok: true, value: 'Oslo' });
  });

  it('works in the Code node, in both modes', async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    await make(agent, 'city', 'Lima');
    const start = node('Start', 'manualTrigger');
    const all = await runNodes(agent, [start, node('Code', 'code', { mode: 'runOnceForAllItems', jsCode: 'return [{ json: { city: $vars.city, n: Object.keys($vars).length } }];' })]);
    expect(all.output[0]![0]).toEqual({ city: 'Lima', n: 1 });
    const each = await runNodes(agent, [start, node('Code', 'code', { mode: 'runOnceForEachItem', jsCodeEachItem: 'return { json: { city: $vars.city } };' })]);
    expect(each.output[0]![0]).toEqual({ city: 'Lima' });
  });

  it('the Code node gets $env only when allowed in Settings', async () => {
    t = await makeTestApp({ allowEnvAccess: false });
    process.env.FF_VARS_TEST_VISIBLE = 'seen';
    try {
      const agent = await signedIn(t);
      const nodes = [node('Start', 'manualTrigger'), node('Code', 'code', { jsCode: 'return [{ json: { e: $env.FF_VARS_TEST_VISIBLE } }];' })];
      const off = await runNodes(agent, nodes);
      expect(off.status).toBe('error');
      expect(off.error?.message).toMatch(/\$env/);
      await agent.patch('/api/settings').send({ allowEnvAccess: true });
      expect((await runNodes(agent, nodes)).output[0]![0]).toEqual({ e: 'seen' });
    } finally {
      delete process.env.FF_VARS_TEST_VISIBLE;
    }
  });
});
