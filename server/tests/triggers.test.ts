import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Item } from '@flowforge/shared';
import { waitLimits } from '../src/nodes/flow/wait.node.js';
import { compileRules, ruleToCron, scheduleItem } from '../src/nodes/_shared/schedule.js';
import { ignoreMatcher } from '../src/nodes/triggers/local-file-trigger.node.js';
import { dedupe } from '../src/triggers/dedupe.js';
import { makeTestApp, waitFor, type TestApp } from './helpers.js';
import { activate, chain, createWorkflow, executions, finished, node, output, signedIn, type Agent } from './trigger-helpers.js';

let t: TestApp;
let agent: Agent;
const savedWait = waitLimits.inMemoryMaxMs;

beforeEach(async () => {
  t = await makeTestApp();
  agent = await signedIn(t);
});
afterEach(async () => {
  waitLimits.inMemoryMaxMs = savedWait;
  await t.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tiny HTTP server whose JSON / text answer can be changed during a test. */
async function fakeApi(): Promise<{ url: string; set(body: unknown, type?: string, status?: number): void; server: Server }> {
  let body: unknown = [];
  let type = 'application/json';
  let status = 200;
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    set: (b, ty = 'application/json', st = 200) => {
      body = b;
      type = ty;
      status = st;
    },
    server,
  };
}
const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

describe('schedule trigger', () => {
  it('converts interval rules to cron patterns', () => {
    expect(ruleToCron({ field: 'seconds', secondsInterval: 10 }).pattern).toBe('*/10 * * * * *');
    expect(ruleToCron({ field: 'minutes', minutesInterval: 15 }).pattern).toBe('0 */15 * * * *');
    expect(ruleToCron({ field: 'hours', hoursInterval: 2, triggerAtMinute: 30 }).pattern).toBe('0 30 */2 * * *');
    expect(ruleToCron({ field: 'days', daysInterval: 1, triggerAtHour: 9, triggerAtMinute: 5 }).pattern).toBe('0 5 9 */1 * *');
    expect(ruleToCron({ field: 'weeks', weeksInterval: 2, triggerAtDay: [5, 1], triggerAtHour: 8 })).toEqual({ pattern: '0 0 8 * * 1,5', everyWeeks: 2 });
    expect(ruleToCron({ field: 'months', monthsInterval: 3, triggerAtDayOfMonth: 15, triggerAtHour: 12 }).pattern).toBe('0 0 12 15 */3 *');
    expect(ruleToCron({ field: 'cronExpression', expression: ' 0 9 * * 1-5 ' }).pattern).toBe('0 9 * * 1-5');
  });

  it('uses the workflow timezone and rejects unknown timezones', () => {
    expect(scheduleItem('Asia/Tokyo').Timezone).toMatch(/^Asia\/Tokyo \(UTC\+09:00\)$/);
    const rule = { rule: { interval: [{ field: 'seconds', secondsInterval: 10 }] } };
    expect(compileRules(rule, 'Europe/Paris')).toEqual([{ pattern: '*/10 * * * * *' }]);
    expect(() => compileRules(rule, 'Mars/Olympus')).toThrow('Unknown timezone "Mars/Olympus"');
  });

  it('fires on schedule while active, only once per tick even if activated twice, and stops when deactivated', async () => {
    const nodes = [node('Every second', 'scheduleTrigger', { rule: { interval: [{ field: 'seconds', secondsInterval: 1 }] } }), node('Next', 'noOp')];
    const id = await createWorkflow(agent, { name: 'Ticker', nodes, connections: chain('Every second', 'Next') });
    expect((await activate(agent, id)).status).toBe(200);
    expect((await activate(agent, id)).status).toBe(200); // second activation must not add a second job
    expect(t.activeWorkflows.listenerCount).toBe(1);
    await sleep(2300);
    const count = executions(t, id).length;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(3);
    const first = await finished(t, executions(t, id)[0]!.id);
    expect(first.mode).toBe('schedule');
    expect(output(first, 'Next')[0]).toMatchObject({ timestamp: expect.any(String), 'Day of week': expect.any(String) });
    await agent.post(`/api/workflows/${id}/deactivate`);
    expect(t.activeWorkflows.listenerCount).toBe(0);
    const after = executions(t, id).length;
    await sleep(1300);
    expect(executions(t, id).length).toBe(after);
  });

  it('refuses an invalid cron expression with a clear message', async () => {
    const id = await createWorkflow(agent, { name: 'Bad cron', nodes: [node('Cron', 'scheduleTrigger', { rule: { interval: [{ field: 'cronExpression', expression: '99 * * *' }] } })], connections: {} });
    const res = await activate(agent, id);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/^Cron: Invalid cron expression "99 \* \* \*"/);
    expect(res.body.error.hint).toMatch(/every 10 seconds/);
    expect((await agent.get(`/api/workflows/${id}`)).body).toMatchObject({ active: false, activationError: expect.stringContaining('Invalid cron') });
  });

  it('"Listen for test event" fires right away', async () => {
    const nodes = [node('Daily', 'scheduleTrigger')];
    const workflow = { name: 'Test schedule', nodes, connections: {} };
    const id = await createWorkflow(agent, workflow);
    const res = await agent.post(`/api/workflows/${id}/test-listen`).send({ workflow, nodeName: 'Daily' });
    expect(res.body.kind).toBe('schedule');
    const done = await finished(t, res.body.executionId);
    expect(done).toMatchObject({ status: 'success', mode: 'manual' });
  });
});

describe('polling triggers', () => {
  const items = (...ids: number[]): Item[] => ids.map((id) => ({ json: { id, title: `t${id}` } }));

  it('dedupe: first run only remembers, then emits new items once; key field or SHA-256; LRU limit', () => {
    const state: Record<string, unknown> = {};
    expect(dedupe(state, items(1, 2), { key: 'id' })).toEqual([]);
    expect(dedupe(state, items(1, 2, 3), { key: 'id' }).map((i) => i.json.id)).toEqual([3]);
    expect(dedupe(state, items(3), { key: 'id' })).toEqual([]);
    expect(dedupe({}, items(1), { emitExistingOnFirstRun: true })).toHaveLength(1);
    const hashed: Record<string, unknown> = { initialized: true };
    expect(dedupe(hashed, [{ json: { a: 1, b: 2 } }])).toHaveLength(1);
    expect(dedupe(hashed, [{ json: { b: 2, a: 1 } }])).toHaveLength(0); // same object, other key order
    const capped: Record<string, unknown> = { initialized: true };
    dedupe(capped, items(...Array.from({ length: 30 }, (_, i) => i)), { key: 'id', max: 10 });
    expect((capped.seen as string[]).length).toBe(10);
  });

  it('HTTP poll trigger: baseline first, then only new items; static data is persisted; errors turn the status red', async () => {
    const api = await fakeApi();
    servers.push(api.server);
    api.set({ data: { items: [{ id: 1 }, { id: 2 }] } });
    const nodes = [node('Poll', 'httpPollTrigger', { url: api.url, itemsPath: 'data.items', dedupeKey: 'id', pollInterval: 1, pollUnit: 'seconds' })];
    const id = await createWorkflow(agent, { name: 'Poller', nodes, connections: {} });
    expect((await activate(agent, id)).status).toBe(200);
    await sleep(300);
    expect(executions(t, id)).toHaveLength(0);
    api.set({ data: { items: [{ id: 1 }, { id: 2 }, { id: 3 }] } });
    const run = await waitFor(() => executions(t, id)[0], 3000, 'poll execution');
    expect(output(await finished(t, run.id), 'Poll')).toEqual([{ id: 3 }]);
    expect(t.ctx.workflowsRepo.getStaticData(id).Poll).toMatchObject({ initialized: true, seen: ['k:1', 'k:2', 'k:3'] });
    api.set('down', 'text/plain', 500);
    const broken = await waitFor(() => t.ctx.workflowsRepo.get(id)?.triggerError, 3000, 'trigger error');
    expect(broken).toMatch(/Poll: .* answered HTTP 500/);
    expect(t.ctx.workflowsRepo.get(id)?.active).toBe(true);
    await sleep(1200);
    expect(executions(t, id)).toHaveLength(1);
  });

  it('RSS feed trigger: test event returns the newest item; active workflow emits new posts only', async () => {
    const rss = (...titles: string[]) =>
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>${titles
        .map((title) => `<item><title>${title}</title><link>https://blog.example/${title}</link><guid>${title}</guid></item>`)
        .join('')}</channel></rss>`;
    const feed = await fakeApi();
    servers.push(feed.server);
    feed.set(rss('second', 'first'), 'application/rss+xml');
    const nodes = [node('Feed', 'rssFeedTrigger', { feedUrl: feed.url, pollInterval: 1, pollUnit: 'seconds' })];
    const workflow = { name: 'Blog', nodes, connections: {} };
    const id = await createWorkflow(agent, workflow);
    const test = await agent.post(`/api/workflows/${id}/test-listen`).send({ workflow, nodeName: 'Feed' });
    expect(output(await finished(t, test.body.executionId), 'Feed').map((i) => i.title)).toEqual(['second']);
    await activate(agent, id);
    await sleep(300);
    feed.set(rss('third', 'second', 'first'), 'application/rss+xml');
    const run = await waitFor(() => executions(t, id).find((e) => e.mode === 'trigger'), 3000, 'rss execution');
    expect(output(await finished(t, run.id), 'Feed').map((i) => i.title)).toEqual(['third']);
  });
});

describe('local file trigger', () => {
  let root: string;
  beforeEach(async () => {
    await t.close();
    root = mkdtempSync(join(tmpdir(), 'ff-files-'));
    mkdirSync(join(root, 'inbox'));
    t = await makeTestApp({ filesRoot: root });
    agent = await signedIn(t);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('ignore patterns', () => {
    const ignored = ignoreMatcher('*.tmp, .*, **/drafts/**');
    expect(ignored('a.tmp')).toBe(true);
    expect(ignored('sub/b.tmp')).toBe(true);
    expect(ignored('.hidden')).toBe(true);
    expect(ignored('x/drafts/y.txt')).toBe(true);
    expect(ignored('report.pdf')).toBe(false);
  });

  it('emits add / change / delete events, skips ignored files, and stops when deactivated', async () => {
    const nodes = [node('Watch', 'localFileTrigger', { path: 'inbox', events: ['add', 'change', 'unlink'], options: { ignored: '*.tmp' } })];
    const id = await createWorkflow(agent, { name: 'Watcher', nodes, connections: {} });
    expect((await activate(agent, id)).status).toBe(200);
    writeFileSync(join(root, 'inbox', 'skip.tmp'), 'x');
    writeFileSync(join(root, 'inbox', 'report.txt'), 'v1');
    const added = await waitFor(() => executions(t, id).find((e) => e.status === 'success'), 4000, 'add event');
    expect(output(await finished(t, added.id), 'Watch')[0]).toMatchObject({ event: 'add', path: 'inbox/report.txt', fileName: 'report.txt', folder: 'inbox' });
    unlinkSync(join(root, 'inbox', 'report.txt'));
    await waitFor(() => executions(t, id).length >= 2, 4000, 'unlink event');
    const events = await Promise.all(executions(t, id).map(async (e) => output(await finished(t, e.id), 'Watch')[0]!.event));
    expect(events.sort()).toEqual(['add', 'unlink']);
    await agent.post(`/api/workflows/${id}/deactivate`);
    writeFileSync(join(root, 'inbox', 'late.txt'), 'x');
    await sleep(600);
    expect(executions(t, id)).toHaveLength(2);
  });

  it('"Listen for test event" waits for the next file, runs once, then stops', async () => {
    const nodes = [node('Watch', 'localFileTrigger', { path: 'inbox' })];
    const workflow = { name: 'Watch test', nodes, connections: {} };
    const id = await createWorkflow(agent, workflow);
    const res = await agent.post(`/api/workflows/${id}/test-listen`).send({ workflow, nodeName: 'Watch' });
    expect(res.body).toMatchObject({ kind: 'listener', expiresAt: expect.any(String) });
    expect(t.testListeners.isListening(id)).toBe(true);
    await sleep(200);
    writeFileSync(join(root, 'inbox', 'first.txt'), '1');
    const run = await waitFor(() => executions(t, id)[0], 4000, 'test event');
    expect((await finished(t, run.id)).mode).toBe('manual');
    expect(output(await finished(t, run.id), 'Watch')[0]).toMatchObject({ event: 'add', fileName: 'first.txt' });
    await waitFor(() => !t.testListeners.isListening(id), 2000, 'listener closed');
    writeFileSync(join(root, 'inbox', 'second.txt'), '2');
    await sleep(500);
    expect(executions(t, id)).toHaveLength(1);
  });

  it('refuses folders outside data/files and folders that do not exist', async () => {
    const outside = await createWorkflow(agent, { name: 'Escape', nodes: [node('Watch', 'localFileTrigger', { path: '../../etc' })], connections: {} });
    expect((await activate(agent, outside)).body.error.message).toMatch(/must be inside/);
    const missing = await createWorkflow(agent, { name: 'Missing', nodes: [node('Watch', 'localFileTrigger', { path: 'nope' })], connections: {} });
    expect((await activate(agent, missing)).body.error.message).toMatch(/does not exist/);
  });
});

describe('error workflow', () => {
  it('a failing production execution starts the error workflow with the n8n payload', async () => {
    const errorWf = await createWorkflow(agent, {
      name: 'On error',
      nodes: [node('Error Trigger', 'errorTrigger'), node('Log', 'noOp')],
      connections: chain('Error Trigger', 'Log'),
    });
    const nodes = [node('Webhook', 'webhook', { path: 'fail' }), node('Boom', 'stopAndError', { errorMessage: 'Card declined' })];
    const failing = await createWorkflow(agent, { name: 'Checkout', nodes, connections: chain('Webhook', 'Boom'), settings: { errorWorkflow: errorWf } });
    await activate(agent, failing);
    await request(t.app).get('/webhook/fail').expect(200);
    const failed = await finished(t, (await waitFor(() => executions(t, failing)[0], 3000, 'failure')).id);
    expect(failed.status).toBe('error');
    const handled = await finished(t, (await waitFor(() => executions(t, errorWf)[0], 3000, 'error workflow')).id);
    expect(handled.mode).toBe('error');
    expect(output(handled, 'Log')[0]).toEqual({
      execution: {
        id: failed.id,
        url: `http://ff.test/executions/${failed.id}`,
        error: { message: 'Card declined', name: 'NodeOperationError', node: 'Boom' },
        lastNodeExecuted: 'Boom',
        mode: 'webhook',
      },
      workflow: { id: failing, name: 'Checkout' },
    });
  });

  it('manual runs do not start the error workflow; the Error Trigger shows example data', async () => {
    const errorWf = await createWorkflow(agent, { name: 'On error', nodes: [node('Error Trigger', 'errorTrigger')], connections: {} });
    const workflow = { name: 'Manual fail', nodes: [node('Start', 'manualTrigger'), node('Boom', 'stopAndError', { errorMessage: 'x' })], connections: chain('Start', 'Boom'), settings: { errorWorkflow: errorWf } };
    const res = await agent.post('/api/executions/run').send({ workflow });
    await finished(t, res.body.executionId);
    await sleep(200);
    expect(executions(t, errorWf)).toHaveLength(0);
    const sample = await agent.post('/api/executions/run').send({ workflow: { name: 'x', nodes: [node('Error Trigger', 'errorTrigger')], connections: {} } });
    expect(output(await finished(t, sample.body.executionId), 'Error Trigger')[0]).toMatchObject({ execution: { error: { message: 'Example error message' } } });
  });
});

describe('sub-workflows', () => {
  const child = () =>
    createWorkflow(agent, {
      name: 'Double',
      nodes: [
        node('When called', 'executeWorkflowTrigger'),
        node('Double', 'set', { assignments: { assignments: [{ name: 'double', value: '={{ $json.n * 2 }}', type: 'number' }] } }),
      ],
      connections: chain('When called', 'Double'),
    });
  const parent = (params: Record<string, unknown>) => ({
    name: 'Parent',
    nodes: [node('Start', 'manualTrigger'), node('Numbers', 'test.emit', { items: [{ n: 1 }, { n: 2 }] }), node('Call', 'executeWorkflow', params)],
    connections: chain('Start', 'Numbers', 'Call'),
  });
  const runParent = async (params: Record<string, unknown>) =>
    finished(t, (await agent.post('/api/executions/run').send({ workflow: parent(params) })).body.executionId);

  it('runs a saved workflow once with all items and returns its last node output; the child is linked to the parent', async () => {
    const childId = await child();
    const done = await runParent({ source: 'database', workflowId: childId });
    expect(done.status).toBe('success');
    expect(output(done, 'Call')).toEqual([{ double: 2 }, { double: 4 }]);
    const children = t.ctx.executionsRepo.childrenOf(done.id);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ mode: 'subworkflow', workflowId: childId, parentExecutionId: done.id, status: 'success' });
  });

  it('runs once per item, from inline JSON, and without waiting', async () => {
    const childId = await child();
    const each = await runParent({ source: 'database', workflowId: childId, mode: 'each' });
    expect(output(each, 'Call')).toEqual([{ double: 2 }, { double: 4 }]);
    expect(t.ctx.executionsRepo.childrenOf(each.id)).toHaveLength(2);
    const inline = await runParent({
      source: 'parameter',
      workflowJson: JSON.stringify({ nodes: [node('In', 'executeWorkflowTrigger'), node('Count', 'code', { jsCode: 'return [{ json: { count: $input.all().length } }];' })], connections: chain('In', 'Count') }),
    });
    expect(output(inline, 'Call')).toEqual([{ count: 2 }]);
    const noWait = await runParent({ source: 'database', workflowId: childId, options: { waitForSubWorkflow: false } });
    expect(output(noWait, 'Call')).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('stops self-calling workflows at depth 10 and explains a missing trigger', async () => {
    const loopId = await createWorkflow(agent, { name: 'Loop', nodes: [node('In', 'executeWorkflowTrigger')], connections: {} });
    await agent.put(`/api/workflows/${loopId}`).send({
      name: 'Loop',
      nodes: [node('In', 'executeWorkflowTrigger'), node('Again', 'executeWorkflow', { workflowId: loopId })],
      connections: chain('In', 'Again'),
    });
    const deep = await runParent({ workflowId: loopId });
    expect(deep.status).toBe('error');
    expect(deep.error?.message).toMatch(/Sub-workflow depth limit \(10\) reached/);
    const noTrigger = await createWorkflow(agent, { name: 'No trigger', nodes: [node('Set', 'set')], connections: {} });
    const res = await runParent({ workflowId: noTrigger });
    expect(res.error?.message).toBe('The workflow "No trigger" has no "Execute Workflow Trigger" node');
  });
});

describe('wait node', () => {
  const waitWorkflow = (waitParams: Record<string, unknown>) => ({
    name: 'Approval',
    nodes: [node('Start', 'manualTrigger'), node('Data', 'test.emit', { items: [{ order: 7 }] }), node('Wait', 'wait', waitParams), node('After', 'noOp')],
    connections: chain('Start', 'Data', 'Wait', 'After'),
  });
  const start = async (waitParams: Record<string, unknown>) => (await agent.post('/api/executions/run').send({ workflow: waitWorkflow(waitParams) })).body.executionId as string;
  const status = (id: string) => t.ctx.executionsRepo.get(id)?.status;

  it('short waits happen in memory', async () => {
    const id = await start({ amount: 0.3, unit: 'seconds' });
    expect(status(id)).not.toBe('waiting');
    const done = await finished(t, id);
    expect(done.status).toBe('success');
    expect(output(done, 'After')).toEqual([{ order: 7 }]);
  });

  it('"at specified time" waits until that moment', async () => {
    const at = new Date(Date.now() + 400).toISOString();
    const begin = Date.now();
    const done = await finished(t, await start({ resume: 'specificTime', dateTime: at }));
    expect(done.status).toBe('success');
    expect(Date.now() - begin).toBeGreaterThanOrEqual(300);
    const bad = await finished(t, await start({ resume: 'specificTime', dateTime: 'not a date' }));
    expect(bad.error?.message).toBe('Enter a valid date and time to wait for');
  });

  it('long waits are saved ("waiting") and resumed by the wait tracker', async () => {
    waitLimits.inMemoryMaxMs = 0;
    const id = await start({ amount: 0.6, unit: 'seconds' });
    const waiting = await waitFor(() => (status(id) === 'waiting' ? t.ctx.executionsRepo.get(id) : undefined), 2000, 'waiting');
    expect(waiting).toMatchObject({ waitingNode: 'Wait', waitTill: expect.any(String) });
    const done = await waitFor(() => (status(id) === 'success' ? t.ctx.executionsRepo.get(id) : undefined), 3000, 'resumed');
    expect(output(done!, 'After')).toEqual([{ order: 7 }]);
    expect(done!.runData.Wait).toHaveLength(1);
  });

  it('webhook resume: $execution.resumeUrl continues the execution once', async () => {
    const id = await start({ resume: 'webhook', httpMethod: 'POST' });
    await waitFor(() => status(id) === 'waiting', 2000, 'waiting');
    expect((await request(t.app).get(`/webhook-waiting/${id}`)).status).toBe(405);
    const res = await request(t.app).post(`/webhook-waiting/${id}`).send({ approved: true });
    expect(res.status).toBe(200);
    const done = await finished(t, id);
    expect(done.status).toBe('success');
    expect(output(done, 'Wait')[0]).toMatchObject({ body: { approved: true } });
    expect((await request(t.app).post(`/webhook-waiting/${id}`)).status).toBe(404);
  });

  it('form resume: server-side validation, then the answers continue the workflow', async () => {
    const formFields = {
      values: [
        { fieldLabel: 'Decision', fieldType: 'dropdown', requiredField: true, fieldOptions: { values: [{ option: 'Approve' }, { option: 'Reject' }] } },
        { fieldLabel: 'Email', fieldType: 'email', requiredField: true },
      ],
    };
    const id = await start({ resume: 'form', formTitle: 'Approve order?', formFields });
    await waitFor(() => status(id) === 'waiting', 2000, 'waiting');
    const page = await request(t.app).get(`/form-waiting/${id}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Approve order?');
    const invalid = await request(t.app).post(`/form-waiting/${id}`).type('form').send({ 'field-0': 'Maybe', 'field-1': 'not-an-email' });
    expect(invalid.status).toBe(400);
    expect(invalid.text).toContain('Choose one of the options');
    expect(invalid.text).toContain('Enter a valid email address');
    expect(status(id)).toBe('waiting');
    const ok = await request(t.app).post(`/form-waiting/${id}`).type('form').send({ 'field-0': 'Approve', 'field-1': 'boss@example.com' });
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('Thank you');
    const done = await finished(t, id);
    expect(output(done, 'After')[0]).toMatchObject({ Decision: 'Approve', Email: 'boss@example.com' });
    expect((await request(t.app).get(`/form-waiting/${id}`)).status).toBe(404);
  });

  it('a waiting execution can be stopped', async () => {
    const id = await start({ resume: 'webhook' });
    await waitFor(() => status(id) === 'waiting', 2000, 'waiting');
    expect((await agent.post(`/api/executions/${id}/stop`)).body).toEqual({ stopped: true });
    expect(status(id)).toBe('canceled');
  });

  it('resumes after a server restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ff-restart-'));
    const dbFile = join(dataDir, 'flowforge.db');
    await t.close();
    waitLimits.inMemoryMaxMs = 0;
    t = await makeTestApp({ dataDir }, { dbFile });
    agent = await signedIn(t);
    const id = await start({ amount: 1, unit: 'seconds' });
    await waitFor(() => status(id) === 'waiting', 2000, 'waiting');
    await t.close(); // "stop the app" while the execution waits

    await sleep(1300); // the wait time passes while the server is down
    t = await makeTestApp({ dataDir }, { dbFile });
    expect(status(id)).toBe('waiting');
    await t.boot(); // "restart": overdue waits resume right away
    const done = await waitFor(() => (status(id) === 'success' ? t.ctx.executionsRepo.get(id) : undefined), 3000, 'resumed after restart');
    expect(output(done!, 'After')).toEqual([{ order: 7 }]);
  });
});

describe('activation lifecycle', () => {
  it('workflows without an activatable trigger cannot be activated', async () => {
    const id = await createWorkflow(agent, { name: 'Manual only', nodes: [node('Start', 'manualTrigger')], connections: {} });
    const res = await activate(agent, id);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ message: 'This workflow has no trigger that can be activated', hint: expect.stringContaining('Webhook, Schedule') });
  });

  it('active workflows are re-activated on boot; failures there deactivate with the reason', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ff-boot-'));
    const dbFile = join(dataDir, 'flowforge.db');
    await t.close();
    t = await makeTestApp({ dataDir }, { dbFile });
    agent = await signedIn(t);
    const id = await createWorkflow(agent, { name: 'Boot hook', nodes: [node('Webhook', 'webhook', { path: 'boot' })], connections: {} });
    await activate(agent, id);
    // Simulate a broken saved config: the trigger cannot start anymore.
    const broken = await createWorkflow(agent, { name: 'Broken', nodes: [node('Webhook', 'webhook', { path: 'broken' })], connections: {} });
    await activate(agent, broken);
    t.ctx.db.prepare("UPDATE workflows SET nodes = ? WHERE id = ?").run(JSON.stringify([node('Cron', 'scheduleTrigger', { rule: { interval: [{ field: 'cronExpression', expression: 'nope' }] } })]), broken);
    await t.close();

    t = await makeTestApp({ dataDir }, { dbFile });
    await t.boot();
    expect(t.activeWorkflows.isActive(id)).toBe(true);
    expect((await request(t.app).get('/webhook/boot')).status).toBe(200);
    expect(t.ctx.workflowsRepo.get(broken)).toMatchObject({ active: false, activationError: expect.stringContaining('Invalid cron expression') });
  });

  it('saving an active workflow restarts it with the new version', async () => {
    const id = await createWorkflow(agent, { name: 'Moving', nodes: [node('Webhook', 'webhook', { path: 'old' })], connections: {} });
    await activate(agent, id);
    await agent.put(`/api/workflows/${id}`).send({ name: 'Moving', nodes: [node('Webhook', 'webhook', { path: 'new' })], connections: {} });
    expect((await request(t.app).get('/webhook/old')).status).toBe(404);
    expect((await request(t.app).get('/webhook/new')).status).toBe(200);
    expect(t.webhookRegistry.count('prod')).toBe(1);
  });

  it('nothing leaks: listeners and webhooks are all removed', async () => {
    const id = await createWorkflow(agent, {
      name: 'Many triggers',
      nodes: [node('Webhook', 'webhook', { path: 'a' }), node('Cron', 'scheduleTrigger', { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } })],
      connections: {},
    });
    for (let i = 0; i < 3; i++) await activate(agent, id);
    expect(t.activeWorkflows.listenerCount).toBe(2);
    expect(t.webhookRegistry.count('prod')).toBe(1);
    await agent.post(`/api/workflows/${id}/deactivate`);
    expect(t.activeWorkflows.listenerCount).toBe(0);
    expect(t.webhookRegistry.count()).toBe(0);
    expect(t.ctx.workflowsRepo.get(id)?.active).toBe(false);
  });
});
