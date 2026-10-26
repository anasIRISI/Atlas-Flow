import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionDetail, WorkflowData } from '@flowforge/shared';
import { counters } from './engine-helpers.js';
import { makeTestApp, OWNER, type TestApp } from './helpers.js';
import { chain, node, type Agent } from './trigger-helpers.js';

let t: TestApp;
let agent: Agent;

beforeEach(async () => {
  t = await makeTestApp();
  agent = request.agent(t.app);
  await agent.post('/api/auth/setup').send(OWNER);
  counters.clear();
});
afterEach(async () => {
  await t.close();
});

async function done(id: string): Promise<ExecutionDetail> {
  for (let i = 0; i < 200; i++) {
    const res = await agent.get(`/api/executions/${id}`);
    if (!['queued', 'running'].includes(res.body.status)) return res.body as ExecutionDetail;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('execution did not finish');
}

const okWorkflow = (name = 'Ok'): WorkflowData => ({
  name,
  nodes: [node('Start', 'manualTrigger'), node('Count', 'test.counter', { key: `ok-${name}` })],
  connections: chain('Start', 'Count'),
});
const failingWorkflow = (key: string): WorkflowData => ({
  name: 'Flaky flow',
  nodes: [
    node('Start', 'manualTrigger'),
    node('Before', 'test.counter', { key: `before-${key}` }),
    node('Flaky', 'test.flaky', { key: `flaky-${key}`, failures: 1 }),
    node('After', 'test.counter', { key: `after-${key}` }),
  ],
  connections: chain('Start', 'Before', 'Flaky', 'After'),
});

async function run(workflow: WorkflowData): Promise<ExecutionDetail> {
  const res = await agent.post('/api/executions/run').send({ workflow });
  expect(res.status).toBe(202);
  return done(res.body.executionId);
}

describe('GET /api/executions', () => {
  it('requires login on every new route', async () => {
    const anon = request(t.app);
    expect((await anon.get('/api/executions')).status).toBe(401);
    expect((await anon.delete('/api/executions/1')).status).toBe(401);
    expect((await anon.post('/api/executions/delete').send({ ids: [] })).status).toBe(401);
    expect((await anon.post('/api/executions/1/retry').send({})).status).toBe(401);
    expect((await anon.post('/api/executions/prune').send({})).status).toBe(401);
  });

  it('filters by status, mode and date, with total and cursor pagination', async () => {
    await run(okWorkflow('A'));
    await run(okWorkflow('B'));
    await run(failingWorkflow('list'));
    const all = (await agent.get('/api/executions')).body;
    expect(all.total).toBe(3);
    expect(all.items[0]).toMatchObject({ status: 'error', workflowName: 'Flaky flow', retryOf: null });
    expect(typeof all.items[0].durationMs).toBe('number');
    expect(typeof all.items[0].createdAt).toBe('string');

    expect((await agent.get('/api/executions?status=error')).body.total).toBe(1);
    expect((await agent.get('/api/executions?status=error,success')).body.total).toBe(3);
    expect((await agent.get('/api/executions?mode=webhook')).body.total).toBe(0);
    expect((await agent.get('/api/executions?mode=manual&status=success')).body.total).toBe(2);
    expect((await agent.get('/api/executions?from=2999-01-01')).body.total).toBe(0);
    expect((await agent.get('/api/executions?to=2000-01-01')).body.total).toBe(0);
    expect((await agent.get('/api/executions?from=2000-01-01&to=2999-01-01')).body.total).toBe(3);

    const page1 = (await agent.get('/api/executions?limit=2')).body;
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(3);
    expect(page1.nextCursor).toBe(page1.items[1].id);
    const page2 = (await agent.get(`/api/executions?limit=2&cursor=${page1.nextCursor}`)).body;
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    expect(page2.total).toBe(3);
  });

  it('rejects bad input with 400', async () => {
    for (const q of ['status=nope', 'mode=x', 'from=yesterday-ish', 'limit=0', 'limit=500', 'cursor=abc']) {
      const res = await agent.get(`/api/executions?${q}`);
      expect(res.status, q).toBe(400);
    }
  });
});

describe('delete', () => {
  it('deletes finished executions and refuses running ones', async () => {
    const ok = await run(okWorkflow());
    expect((await agent.delete(`/api/executions/${ok.id}`)).body).toEqual({ deleted: 1 });
    expect((await agent.get(`/api/executions/${ok.id}`)).status).toBe(404);
    expect((await agent.delete('/api/executions/9999')).status).toBe(404);

    const slow: WorkflowData = {
      name: 'Slow',
      nodes: [node('Start', 'manualTrigger'), node('Slow', 'test.slow', { ms: 5000 })],
      connections: chain('Start', 'Slow'),
    };
    const started = (await agent.post('/api/executions/run').send({ workflow: slow })).body.executionId as string;
    await new Promise((r) => setTimeout(r, 100));
    const res = await agent.delete(`/api/executions/${started}`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/stop it first|running|queued/i);
    const bulk = await agent.post('/api/executions/delete').send({ ids: [started, '9999'] });
    expect(bulk.body).toEqual({ deleted: 0 });
    await agent.post(`/api/executions/${started}/stop`);
    const stopped = await done(started);
    expect(stopped.status).toBe('canceled');
    expect((await agent.post('/api/executions/delete').send({ ids: [started] })).body).toEqual({ deleted: 1 });
    expect((await agent.post('/api/executions/delete').send({ ids: ['x'] })).status).toBe(400);
  });
});

describe('retry', () => {
  it('retries from the failed node: earlier nodes are reused, not executed again', async () => {
    const failed = await run(failingWorkflow('a'));
    expect(failed.status).toBe('error');
    expect(counters.get('before-a')).toBe(1);
    expect(counters.get('after-a')).toBeUndefined();

    const res = await agent.post(`/api/executions/${failed.id}/retry`).send({});
    expect(res.status).toBe(202);
    const retried = await done(res.body.executionId);
    expect(retried.status).toBe('success');
    expect(retried.mode).toBe('retry');
    const listed = (await agent.get('/api/executions')).body.items[0];
    expect(listed.retryOf).toBe(failed.id);
    expect(counters.get('before-a')).toBe(1); // not executed again
    expect(counters.get('after-a')).toBe(1); // continued after the failed node
    expect(retried.runData.Before![0]!.status).toBe('reused');
    expect(retried.runData.Flaky![0]!.status).toBe('success');
    expect(retried.runData.After![0]!.data.main[0]).toHaveLength(1);
  });

  it('retries from the failed node with several branches: finished branches are reused, every leaf after the failure runs', async () => {
    const at = (name: string, type: string, key: string, y: number, extra = {}) => node(name, type, { key, ...extra }, { position: [400, y] });
    const wf: WorkflowData = {
      name: 'Branches',
      nodes: [
        node('Start', 'manualTrigger'),
        node('Before', 'test.counter', { key: 'br-before' }),
        at('Side', 'test.counter', 'br-side', 0),
        at('Flaky', 'test.flaky', 'br-flaky', 200, { failures: 1 }),
        at('Leaf1', 'test.counter', 'br-leaf1', 100),
        at('Leaf2', 'test.counter', 'br-leaf2', 300),
      ],
      connections: {
        Start: { main: [[{ node: 'Before', type: 'main', index: 0 }]] },
        Before: { main: [[{ node: 'Side', type: 'main', index: 0 }, { node: 'Flaky', type: 'main', index: 0 }]] },
        Flaky: { main: [[{ node: 'Leaf1', type: 'main', index: 0 }, { node: 'Leaf2', type: 'main', index: 0 }]] },
      },
    } as unknown as WorkflowData;
    const failed = await run(wf);
    expect(failed.status).toBe('error');
    expect(counters.get('br-side')).toBe(1);

    const res = await agent.post(`/api/executions/${failed.id}/retry`).send({});
    const retried = await done(res.body.executionId);
    expect(retried.status).toBe('success');
    expect(counters.get('br-before')).toBe(1);
    expect(counters.get('br-side')).toBe(1); // the branch that had finished is not run again
    expect(counters.get('br-leaf1')).toBe(1);
    expect(counters.get('br-leaf2')).toBe(1);
    expect(retried.runData.Start![0]!.status).toBe('reused');
    expect(retried.runData.Side![0]!.status).toBe('reused');
  });

  it('can rerun everything', async () => {
    const failed = await run(failingWorkflow('b'));
    const res = await agent.post(`/api/executions/${failed.id}/retry`).send({ fromFailedNode: false });
    const retried = await done(res.body.executionId);
    expect(retried.status).toBe('success');
    expect(counters.get('before-b')).toBe(2);
  });

  it('refuses to retry a successful execution, and unknown ones', async () => {
    const ok = await run(okWorkflow());
    const res = await agent.post(`/api/executions/${ok.id}/retry`).send({});
    expect(res.status).toBe(400);
    expect((await agent.post('/api/executions/9999/retry').send({})).status).toBe(404);
  });

  it('useCurrentWorkflow needs the saved workflow (404 when deleted)', async () => {
    const wfBody = failingWorkflow('c');
    const id = (await agent.post('/api/workflows').send(wfBody)).body.id as string;
    const failed = await run({ ...wfBody, id });
    expect(failed.status).toBe('error');
    await agent.delete(`/api/workflows/${id}`);
    const res = await agent.post(`/api/executions/${failed.id}/retry`).send({ useCurrentWorkflow: true });
    expect(res.status).toBe(404);
  });
});

describe('prune endpoint', () => {
  it('prunes by retention settings and reports how many', async () => {
    await run(okWorkflow('p1'));
    await run(okWorkflow('p2'));
    await run(okWorkflow('p3'));
    await agent.patch('/api/settings').send({ pruneMaxCount: 1 });
    expect((await agent.post('/api/executions/prune').send({})).body).toEqual({ deleted: 2 });
    expect((await agent.get('/api/executions')).body.total).toBe(1);
  });
});
