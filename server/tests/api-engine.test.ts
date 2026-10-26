import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerEvent, WorkflowData } from '@flowforge/shared';
import { getCodeSandbox } from '../src/engine/code/sandbox.js';
import { ExecutionQueue } from '../src/engine/queue.js';
import { listen, makeTestApp, OWNER, type TestApp } from './helpers.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'workflows');
const fixture = (name: string): WorkflowData => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as WorkflowData;

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
afterAll(async () => {
  await getCodeSandbox().close();
});

const runFixture = async (name: string, query = '') => {
  const res = await agent.post(`/api/dev/run${query}`).send(fixture(name));
  expect(res.status).toBe(200);
  return res.body as {
    executionId: string;
    status: string;
    error: { message: string; node?: string } | null;
    nodes: Array<{ node: string; run: number; status: string; items: number[]; error?: string }>;
    output: unknown[][];
    lastNodeExecuted: string;
  };
};

describe('workflow fixtures through POST /api/dev/run', () => {
  it('01 hello world', async () => {
    const r = await runFixture('01-hello-world');
    expect(r.status).toBe('success');
    expect(r.output[0]).toEqual([
      { name: 'Ada', age: 36, greeting: 'Hello Ada, next year you will be 37', workflow: '01 Hello world' },
      { name: 'Alan', age: 41, greeting: 'Hello Alan, next year you will be 42', workflow: '01 Hello world' },
      { name: 'Grace', age: 85, greeting: 'Hello Grace, next year you will be 86', workflow: '01 Hello world' },
    ]);
    expect(r.nodes.map((n) => n.node)).toEqual(['Start', 'Make users', 'Greet']);
  });

  it('02 IF branches (top branch first)', async () => {
    const r = await runFixture('02-if-branches');
    expect(r.nodes.map((n) => `${n.node}:${n.items.join('/')}`)).toEqual(['Start:1', 'People:3', 'Older than 40?:2/1', 'Senior:2', 'Junior:1']);
  });

  it('03 merge with a branch that never runs', async () => {
    const r = await runFixture('03-merge-never-taken');
    expect(r.status).toBe('success');
    expect(r.nodes.find((n) => n.node === 'Kids')).toBeUndefined();
    expect(r.output[0]).toEqual([{ people: 2, names: ['Ada', 'Alan'] }]);
  });

  it('04 loop over items in batches', async () => {
    const r = await runFixture('04-loop-batches');
    expect(r.output[0]).toEqual([{ squares: [1, 4, 9, 16, 25], total: 55, rounds: 3 }]);
    expect(r.nodes.filter((n) => n.node === 'Square')).toHaveLength(3);
  });

  it('05 error output with retry', async () => {
    const r = await runFixture('05-error-output');
    expect(r.status).toBe('success');
    const validate = r.nodes.find((n) => n.node === 'Validate')!;
    expect(validate.items).toEqual([2, 1]);
    const report = (await agent.get(`/api/executions/${r.executionId}`)).body.runData['Report problem'][0].data.main[0];
    expect(report[0].json.alert).toBe('Check the orders: Order 2 has a negative quantity [line 1]');
  });

  it('06 merge users and orders by id', async () => {
    const r = await runFixture('06-merge-by-key');
    expect(r.output[0]).toEqual([
      { userId: 1, name: 'Ada', customer: 1, total: 120 },
      { userId: 3, name: 'Grace', customer: 3, total: 75 },
      { userId: 2, name: 'Alan' },
    ]);
  });

  it('07 switch, filter and limit', async () => {
    const r = await runFixture('07-switch-filter-limit');
    const byNode = Object.fromEntries(r.nodes.map((n) => [n.node, n.items]));
    expect(byNode['Route by priority']).toEqual([2, 1, 2]);
    expect(byNode['First high']).toEqual([1]);
    expect(byNode['Known priority only']).toEqual([1, 1]);
  });

  it('08 stop and error', async () => {
    const r = await runFixture('08-stop-and-error');
    expect(r.status).toBe('error');
    expect(r.error).toMatchObject({ message: 'Keyboard is out of stock', node: 'Out of stock' });
    expect(r.lastNodeExecuted).toBe('Out of stock');
  });

  it('partial run via ?destinationNode stops at that node', async () => {
    const r = await runFixture('01-hello-world', '?destinationNode=Make%20users');
    expect(r.nodes.map((n) => n.node)).toEqual(['Start', 'Make users']);
  });

  it('rejects malformed workflow JSON with a readable message', async () => {
    const res = await agent.post('/api/dev/run').send({ nodes: [{ name: 'x' }], connections: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/workflow\.nodes\.0\.type/);
  });
});

describe('executions API and persistence', () => {
  it('stores executions with run data and lists them newest first', async () => {
    const first = await runFixture('01-hello-world');
    const second = await runFixture('08-stop-and-error');
    const list = (await agent.get('/api/executions')).body.items;
    expect(list.map((e: { id: string }) => e.id)).toEqual([second.executionId, first.executionId]);
    expect(list[0]).toMatchObject({ status: 'error', workflowName: '08 Stop and Error', errorMessage: 'Keyboard is out of stock', mode: 'manual' });
    const detail = (await agent.get(`/api/executions/${first.executionId}`)).body;
    expect(detail.runData.Greet[0].data.main[0]).toHaveLength(3);
    expect(detail.workflow.name).toBe('01 Hello world');
    expect(detail.events.map((e: { type: string; node: string }) => `${e.type}:${e.node}`)).toEqual([
      'node.started:Start', 'node.finished:Start', 'node.started:Make users', 'node.finished:Make users', 'node.started:Greet', 'node.finished:Greet',
    ]);
    expect((await agent.get('/api/executions/999')).status).toBe(404);
  });

  it('runs in the background with ?wait=false and can be stopped', async () => {
    const workflow = {
      name: 'Slow',
      nodes: [
        { name: 'T', type: 'flowforge.manualTrigger', parameters: {} },
        { name: 'Slow', type: 'test.slow', parameters: { ms: 5000 } },
      ],
      connections: { T: { main: [[{ node: 'Slow', type: 'main', index: 0 }]] } },
    };
    const started = await agent.post('/api/dev/run?wait=false').send(workflow);
    expect(started.status).toBe(202);
    const id = started.body.executionId as string;
    await new Promise((r) => setTimeout(r, 100));
    expect((await agent.get(`/api/executions/${id}`)).body.status).toBe('running');
    expect((await agent.post(`/api/executions/${id}/stop`)).body).toEqual({ stopped: true });
    await new Promise((r) => setTimeout(r, 100));
    const detail = (await agent.get(`/api/executions/${id}`)).body;
    expect(detail.status).toBe('canceled');
    expect(detail.errorMessage).toBe('Execution was stopped');
  });

  it('marks executions interrupted by a restart as crashed', () => {
    const id = t.ctx.executionsRepo.create({ workflow: fixture('01-hello-world'), mode: 'manual' });
    t.ctx.executionsRepo.markRunning(id, new Date());
    expect(t.ctx.executionsRepo.markUnfinishedAsCrashed()).toBe(1);
    expect(t.ctx.executionsRepo.get(id)).toMatchObject({ status: 'crashed', errorMessage: 'The server stopped while this execution was running' });
  });

  it('streams live events over WebSocket in order', async () => {
    const base = await listen(t);
    const cookie = (await request(t.app).post('/api/auth/login').send(OWNER)).headers['set-cookie']![0]!.split(';')[0]!;
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie } });
    const events: ServerEvent[] = [];
    socket.on('message', (raw) => events.push(JSON.parse(raw.toString()) as ServerEvent));
    await new Promise((resolve) => socket.once('message', resolve));
    socket.send(JSON.stringify({ type: 'subscribe', room: 'workflow:wf-live' }));
    socket.send(JSON.stringify({ type: 'ping' }));
    await new Promise((r) => setTimeout(r, 50));

    const workflow = { ...fixture('02-if-branches'), id: 'wf-live' };
    await agent.post('/api/dev/run').send(workflow);
    await new Promise((r) => setTimeout(r, 100));
    socket.close();

    const run = events.filter((e) => e.type !== 'connection.ready' && e.type !== 'pong');
    const types = run.map((e) => e.type);
    expect(types[0]).toBe('execution.queued');
    expect(types[1]).toBe('execution.started');
    expect(types[types.length - 1]).toBe('execution.finished');
    const seqs = run.filter((e) => e.seq !== undefined).map((e) => e.seq!);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const ifFinished = run.find((e) => e.type === 'node.finished' && e.data.nodeName === 'Older than 40?');
    expect(ifFinished?.data).toMatchObject({ itemCounts: [2, 1], status: 'success' });
    expect((ifFinished?.data as { preview: unknown[] }).preview).toEqual([{ name: 'Alan', age: 41 }, { name: 'Grace', age: 85 }]);
    const edges = run.filter((e) => e.type === 'edge.data').map((e) => {
      const d = e.data as { from: { node: string; output: number }; to: { node: string }; itemCount: number };
      return `${d.from.node}[${d.from.output}]->${d.to.node}:${d.itemCount}`;
    });
    expect(edges).toEqual(['Start[0]->People:1', 'People[0]->Older than 40?:3', 'Older than 40?[0]->Senior:2', 'Older than 40?[1]->Junior:1']);
    expect(run.find((e) => e.type === 'execution.finished')?.data).toMatchObject({ status: 'success', lastNodeExecuted: 'Junior' });
  });

  it('serves binary data with safe headers', async () => {
    const r = await agent.post('/api/dev/run').send({
      name: 'File',
      nodes: [
        { name: 'T', type: 'flowforge.manualTrigger', parameters: {} },
        { name: 'Make', type: 'test.makeFile', parameters: {} },
      ],
      connections: { T: { main: [[{ node: 'Make', type: 'main', index: 0 }]] } },
    });
    expect(r.body.status).toBe('success');
    const detail = (await agent.get(`/api/executions/${r.body.executionId}`)).body;
    const ref = detail.runData.Make[0].data.main[0][0].binary.data;
    const file = await agent.get(`/api/binary-data/${ref.id}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toMatch(/text\/csv/);
    expect(file.headers['content-security-policy']).toMatch(/sandbox/);
    expect(file.text).toBe('a,b\n1,2');
  });

  it('refuses invalid binary ids', async () => {
    expect((await agent.get('/api/binary-data/..%2F..%2Fetc/passwd')).status).toBe(400);
    expect((await agent.get('/api/binary-data/1/missing')).status).toBe(404);
  });
});

describe('queue', () => {
  it('runs manual (high priority) jobs before waiting triggered jobs', async () => {
    const queue = new ExecutionQueue(1);
    const order: string[] = [];
    const job = (name: string, ms: number) => async () => {
      order.push(name);
      await new Promise((r) => setTimeout(r, ms));
    };
    queue.add('a', job('a', 30), () => {}, 'normal');
    queue.add('b', job('b', 1), () => {}, 'normal');
    queue.add('c', job('c', 1), () => {}, 'high');
    expect(queue.active).toBe(1);
    expect(queue.waiting).toBe(2);
    await new Promise((r) => setTimeout(r, 80));
    expect(order).toEqual(['a', 'c', 'b']);
  });

  it('respects the concurrency limit and can cancel queued executions', async () => {
    await t.close();
    t = await makeTestApp({ maxConcurrentExecutions: 1 });
    agent = request.agent(t.app);
    await agent.post('/api/auth/setup').send(OWNER);
    const slow = (ms: number) => ({
      name: 'Slow',
      nodes: [
        { name: 'T', type: 'flowforge.manualTrigger', parameters: {} },
        { name: 'Slow', type: 'test.slow', parameters: { ms } },
      ],
      connections: { T: { main: [[{ node: 'Slow', type: 'main', index: 0 }]] } },
    });
    const a = (await agent.post('/api/dev/run?wait=false').send(slow(300))).body.executionId;
    const b = (await agent.post('/api/dev/run?wait=false').send(slow(10))).body.executionId;
    const c = (await agent.post('/api/dev/run?wait=false').send(slow(10))).body.executionId;
    await new Promise((r) => setTimeout(r, 50));
    expect((await agent.get(`/api/executions/${b}`)).body.status).toBe('queued');
    expect((await agent.post(`/api/executions/${c}/stop`)).body).toEqual({ stopped: true });
    await new Promise((r) => setTimeout(r, 500));
    const [ea, eb, ec] = await Promise.all([a, b, c].map(async (id) => (await agent.get(`/api/executions/${id}`)).body));
    expect(ea.status).toBe('success');
    expect(eb.status).toBe('success');
    expect(Date.parse(eb.startedAt)).toBeGreaterThanOrEqual(Date.parse(ea.stoppedAt));
    expect(ec.status).toBe('canceled');
  });
});

describe('editor support endpoints', () => {
  it('GET /api/node-types lists node schemas (login required)', async () => {
    expect((await request(t.app).get('/api/node-types')).status).toBe(401);
    const res = await agent.get('/api/node-types');
    const ifNode = res.body.find((n: { type: string }) => n.type === 'flowforge.if');
    expect(ifNode).toMatchObject({ displayName: 'If', group: 'flow' });
    expect(ifNode.outputs.map((o: { displayName: string }) => o.displayName)).toEqual(['true', 'false']);
    expect(ifNode.properties[0]).toMatchObject({ name: 'conditions', type: 'conditions' });
  });

  it('POST /api/node-types/outputs computes dynamic outputs', async () => {
    const res = await agent.post('/api/node-types/outputs').send({ node: { type: 'flowforge.switch', parameters: { mode: 'expression', numberOutputs: 3 }, onError: 'continueErrorOutput' } });
    expect(res.body.map((o: { displayName: string }) => o.displayName)).toEqual(['0', '1', '2', 'error']);
  });

  it('POST /api/expressions/preview evaluates expressions safely', async () => {
    const ok = await agent.post('/api/expressions/preview').send({ expression: '={{ $json.name.toUpperCase() }} is {{ $json.age }}', inputItems: [{ name: 'Ada', age: 36 }] });
    expect(ok.body).toEqual({ ok: true, value: 'ADA is 36', type: 'string' });
    const num = await agent.post('/api/expressions/preview').send({ expression: '={{ [1,2,3].sum() }}' });
    expect(num.body).toEqual({ ok: true, value: 6, type: 'number' });
    const bad = await agent.post('/api/expressions/preview').send({ expression: '={{ process.exit() }}' });
    expect(bad.body).toMatchObject({ ok: false, error: { name: 'ExpressionError', message: '"process" is not allowed in expressions' } });
  });

  it('the dev endpoint can be switched off', async () => {
    await t.close();
    t = await makeTestApp({ devApi: false });
    agent = request.agent(t.app);
    await agent.post('/api/auth/setup').send(OWNER);
    expect((await agent.post('/api/dev/run').send(fixture('01-hello-world'))).status).toBe(404);
  });
});
