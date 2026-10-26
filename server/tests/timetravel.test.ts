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

const wf: WorkflowData = {
  name: 'Rerun',
  nodes: [node('Start', 'manualTrigger'), node('A', 'test.counter', { key: 'tt-a' }), node('B', 'test.counter', { key: 'tt-b' }), node('C', 'test.counter', { key: 'tt-c' })],
  connections: chain('Start', 'A', 'B', 'C'),
};

describe('POST /api/executions/run with rerunFrom', () => {
  it('reuses everything before the node and runs the node and what follows again; stored execution is untouched', async () => {
    const first = await agent.post('/api/executions/run').send({ workflow: wf });
    const prev = await done(first.body.executionId);
    expect(prev.status).toBe('success');
    const before = JSON.stringify((await agent.get(`/api/executions/${prev.id}`)).body);
    const res = await agent.post('/api/executions/run').send({ workflow: wf, rerunFrom: 'B', previousExecutionId: prev.id });
    expect(res.status).toBe(202);
    const next = await done(res.body.executionId);
    expect(next.id).not.toBe(prev.id);
    expect(next.status).toBe('success');
    expect(next.runData.Start![0]!.status).toBe('reused');
    expect(next.runData.A![0]!.status).toBe('reused');
    expect(next.runData.B![0]!.status).toBe('success');
    expect(next.runData.C![0]!.status).toBe('success');
    expect(JSON.stringify((await agent.get(`/api/executions/${prev.id}`)).body)).toBe(before);
  });

  it('400 for an unknown node, 404 for an unknown execution, login required', async () => {
    const bad = await agent.post('/api/executions/run').send({ workflow: wf, rerunFrom: 'Nope', previousExecutionId: '1' });
    expect(bad.status).toBe(400);
    const missing = await agent.post('/api/executions/run').send({ workflow: wf, rerunFrom: 'B', previousExecutionId: '999999' });
    expect(missing.status).toBe(404);
    expect((await request(t.app).post('/api/executions/run').send({ workflow: wf, rerunFrom: 'B' })).status).toBe(401);
  });
});
