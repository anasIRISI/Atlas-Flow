import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionDetail, WorkflowData } from '@flowforge/shared';
import { MissingCredentialError, serializeError } from '../src/engine/errors.js';
import { makeTestApp, OWNER, type TestApp } from './helpers.js';

const fixture = (name: string): WorkflowData =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'workflows', `${name}.json`), 'utf8')) as WorkflowData;

let t: TestApp;
let agent: ReturnType<typeof request.agent>;

beforeEach(async () => {
  t = await makeTestApp();
  agent = request.agent(t.app);
  await agent.post('/api/auth/setup').send(OWNER);
});
afterEach(async () => {
  await t.close();
});

async function waitForExecution(id: string): Promise<ExecutionDetail> {
  for (let i = 0; i < 100; i++) {
    const res = await agent.get(`/api/executions/${id}`);
    if (!['queued', 'running'].includes(res.body.status)) return res.body as ExecutionDetail;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('execution did not finish');
}

describe('workflows API', () => {
  it('requires login', async () => {
    expect((await request(t.app).get('/api/workflows')).status).toBe(401);
  });

  it('creates workflows with unique default names', async () => {
    const a = await agent.post('/api/workflows').send({});
    const b = await agent.post('/api/workflows').send({});
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ name: 'My workflow', nodes: [], connections: {}, active: false });
    expect(a.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.body.name).toBe('My workflow 2');
  });

  it('saves, loads, renames, lists and deletes', async () => {
    const created = (await agent.post('/api/workflows').send({ name: 'Hello' })).body;
    const saved = await agent.put(`/api/workflows/${created.id}`).send({ ...fixture('01-hello-world'), name: 'Hello saved', pinData: { Greet: [{ json: { pinned: 1 } }] } });
    expect(saved.status).toBe(200);
    expect(saved.body.versionId).not.toBe(created.versionId);
    const loaded = (await agent.get(`/api/workflows/${created.id}`)).body;
    expect(loaded.name).toBe('Hello saved');
    expect(loaded.nodes.map((n: { name: string }) => n.name)).toEqual(['Start', 'Make users', 'Greet']);
    expect(loaded.connections.Start.main[0][0].node).toBe('Make users');
    expect(loaded.pinData).toEqual({ Greet: [{ json: { pinned: 1 } }] });

    expect((await agent.patch(`/api/workflows/${created.id}`).send({ name: '  Renamed ' })).body.name).toBe('Renamed');
    const list = (await agent.get('/api/workflows')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: created.id, name: 'Renamed', nodeCount: 3 });

    expect((await agent.delete(`/api/workflows/${created.id}`)).status).toBe(204);
    expect((await agent.get(`/api/workflows/${created.id}`)).status).toBe(404);
    expect((await agent.delete(`/api/workflows/${created.id}`)).status).toBe(404);
  });

  it('validates the workflow with readable messages', async () => {
    const created = (await agent.post('/api/workflows').send({})).body;
    const dup = await agent.put(`/api/workflows/${created.id}`).send({
      name: 'x',
      nodes: [
        { name: 'A', type: 'flowforge.noOp' },
        { name: 'A', type: 'flowforge.noOp' },
      ],
    });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toBe('nodes.1.name: Two nodes are named "A"');
    const empty = await agent.patch(`/api/workflows/${created.id}`).send({ name: '   ' });
    expect(empty.body.error.message).toBe('name: The workflow needs a name');
  });
});

describe('POST /api/executions/run (editor runs)', () => {
  it('runs the posted workflow in the background', async () => {
    const res = await agent.post('/api/executions/run').send({ workflow: { ...fixture('02-if-branches'), id: 'wf-1' } });
    expect(res.status).toBe(202);
    const execution = await waitForExecution(res.body.executionId);
    expect(execution).toMatchObject({ status: 'success', workflowId: 'wf-1', mode: 'manual' });
    expect(execution.runData.Senior![0]!.data.main[0]).toHaveLength(2);
  });

  it('"execute step" reuses the previous execution and runs only up to the node', async () => {
    const workflow = { ...fixture('01-hello-world'), id: 'wf-2' };
    const first = await waitForExecution((await agent.post('/api/executions/run').send({ workflow })).body.executionId);
    const step = await waitForExecution(
      (await agent.post('/api/executions/run').send({ workflow, destinationNode: 'Make users', previousExecutionId: first.id })).body.executionId,
    );
    expect(step.runData.Start![0]!.status).toBe('reused');
    expect(step.runData['Make users']![0]!.status).toBe('success');
    expect(step.runData.Greet).toBeUndefined();
  });

  it('uses pinned data from the posted workflow', async () => {
    const workflow = { ...fixture('01-hello-world'), pinData: { 'Make users': [{ json: { name: 'Pinned', age: 1 } }] } };
    const execution = await waitForExecution((await agent.post('/api/executions/run').send({ workflow })).body.executionId);
    expect(execution.runData['Make users']![0]!.status).toBe('pinned');
    expect(execution.runData.Greet![0]!.data.main[0]![0]!.json.greeting).toBe('Hello Pinned, next year you will be 2');
  });
});

describe('errors for the UI', () => {
  it('missing credentials carry the info for an "Open Credentials" button', () => {
    const err = new MissingCredentialError('telegramApi', 'Telegram', 'TELEGRAM_BOT_TOKEN', '#3-telegram');
    expect(serializeError(err, 'Send message')).toMatchObject({
      name: 'MissingCredentialError',
      message: 'Telegram credentials are missing',
      credentialType: 'telegramApi',
      envVar: 'TELEGRAM_BOT_TOKEN',
      node: 'Send message',
    });
    expect(err.hint).toMatch(/Credentials page or set TELEGRAM_BOT_TOKEN in \.env/);
  });

  it('node types expose subtitles for the canvas', async () => {
    const types = (await agent.get('/api/node-types')).body as Array<{ type: string; subtitle?: string }>;
    expect(types.find((n) => n.type === 'flowforge.merge')?.subtitle).toBe('{{mode}}');
  });
});
