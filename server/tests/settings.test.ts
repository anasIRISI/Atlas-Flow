import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { capturingLogger, makeTestApp, OWNER, type TestApp } from './helpers.js';
import { chain, node, signedIn, type Agent } from './trigger-helpers.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const runCommand = async (agent: Agent, command = 'echo from-flowforge') => {
  const nodes = [node('Start', 'manualTrigger'), node('Shell', 'executeCommand', { command })];
  return (await agent.post('/api/dev/run').send({ name: 'Shell', nodes, connections: chain('Start', 'Shell') })).body as {
    status: string;
    output: Array<Array<Record<string, unknown>>>;
    error?: { message: string; hint?: string; description?: string };
  };
};

describe('instance settings', () => {
  it('needs a session; Execute Command is off by default', async () => {
    t = await makeTestApp();
    expect((await request(t.app).get('/api/settings')).status).toBe(401);
    expect((await request(t.app).patch('/api/settings').send({ executeCommandEnabled: true })).status).toBe(401);
    const agent = await signedIn(t);
    expect((await agent.get('/api/settings')).body).toMatchObject({ executeCommandEnabled: false });
  });

  it('only known settings with the right type are accepted', async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    expect((await agent.patch('/api/settings').send({ executeCommandEnabled: 'yes' })).status).toBe(400);
    expect((await agent.patch('/api/settings').send({ somethingElse: true })).status).toBe(400);
    expect((await agent.patch('/api/settings').send({})).body).toMatchObject({ executeCommandEnabled: false });
    expect((await agent.get('/api/settings')).body).toMatchObject({ executeCommandEnabled: false });
  });

  it('the toggle is the only way to enable the Execute Command node; it survives a restart and is logged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-data-'));
    const dbFile = join(dir, 'flowforge.db');
    const logger = capturingLogger();
    t = await makeTestApp({ dataDir: dir }, { dbFile, logger });
    const agent = await signedIn(t);

    const blocked = await runCommand(agent);
    expect(blocked.status).toBe('error');
    expect(blocked.error).toMatchObject({
      message: 'The Execute Command node is disabled',
      description: 'It runs shell commands on the computer where FlowForge is installed, so it is off by default.',
      hint: 'An administrator can turn it on in Settings → Security → "Allow the Execute Command node".',
    });

    expect((await agent.patch('/api/settings').send({ executeCommandEnabled: true })).body).toMatchObject({ executeCommandEnabled: true });
    expect(logger.lines.some((l) => l.startsWith('warn') && l.includes('Execute Command node ENABLED'))).toBe(true);
    const allowed = await runCommand(agent);
    expect(allowed.status).toBe('success');
    expect(allowed.output).toEqual([[{ exitCode: 0, stdout: 'from-flowforge', stderr: '' }]]);

    // Restart on the same database: still enabled.
    await t.close();
    t = await makeTestApp({ dataDir: dir }, { dbFile });
    const again = request.agent(t.app);
    await again.post('/api/auth/login').send({ email: OWNER.email, password: OWNER.password });
    expect((await again.get('/api/settings')).body).toMatchObject({ executeCommandEnabled: true });
    expect((await runCommand(again)).status).toBe('success');

    // Switching it off takes effect at once.
    await again.patch('/api/settings').send({ executeCommandEnabled: false });
    expect((await runCommand(again)).error?.message).toBe('The Execute Command node is disabled');
  });

  it('no environment variable or node parameter can enable it', async () => {
    t = await makeTestApp({}, { env: { FLOWFORGE_EXECUTE_COMMAND: 'true', EXECUTE_COMMAND_ENABLED: 'true' } });
    const agent = await signedIn(t);
    const nodes = [node('Start', 'manualTrigger'), node('Shell', 'executeCommand', { command: 'echo x', executeCommandEnabled: true, options: { enabled: true } })];
    const res = (await agent.post('/api/dev/run').send({ name: 'Shell', nodes, connections: chain('Start', 'Shell') })).body as { error?: { message: string } };
    expect(res.error?.message).toBe('The Execute Command node is disabled');
  });
});

const runExpr = async (agent: Agent, expression: string, mode: 'manual' | 'trigger' = 'manual') => {
  const nodes = [node('Start', 'manualTrigger'), node('Calc', 'set', { assignments: { assignments: [{ name: 'v', value: expression, type: 'string' }] } })];
  return (await agent.post(`/api/dev/run?mode=${mode}`).send({ name: 'W', nodes, connections: chain('Start', 'Calc') })).body as {
    executionId: string;
    status: string;
    output: Array<Array<Record<string, unknown>>>;
  };
};

describe('instance defaults (Phase 7)', () => {
  it('GET returns the defaults and the effective values (.env fallback)', async () => {
    t = await makeTestApp({ timezone: 'Europe/Paris', maxConcurrentExecutions: 3, executionTimeoutMs: 60_000, allowEnvAccess: true });
    const agent = await signedIn(t);
    const body = (await agent.get('/api/settings')).body;
    expect(body).toMatchObject({ timezone: '', saveDataManual: 'all', pruneMaxAgeDays: 14, allowEnvAccess: null });
    expect(body.effective).toEqual({ timezone: 'Europe/Paris', executionTimeoutSeconds: 60, maxConcurrentExecutions: 3, allowEnvAccess: true });
    const patched = (await agent.patch('/api/settings').send({ timezone: 'Asia/Tokyo', executionTimeoutSeconds: 90, maxConcurrentExecutions: 7, allowEnvAccess: false })).body;
    expect(patched.effective).toEqual({ timezone: 'Asia/Tokyo', executionTimeoutSeconds: 90, maxConcurrentExecutions: 7, allowEnvAccess: false });
  });

  it('validates every field', async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const bad: Array<Record<string, unknown>> = [
      { timezone: 'Mars/Base' },
      { executionTimeoutSeconds: -1 },
      { executionTimeoutSeconds: 86_401 },
      { executionTimeoutSeconds: 1.5 },
      { maxConcurrentExecutions: 51 },
      { allowEnvAccess: 'yes' },
      { saveDataSuccess: 'maybe' },
      { pruneMaxAgeDays: 3651 },
      { pruneMaxCount: 1_000_001 },
    ];
    for (const b of bad) expect((await agent.patch('/api/settings').send(b)).status, JSON.stringify(b)).toBe(400);
    expect((await agent.patch('/api/settings').send({ timezone: '', allowEnvAccess: null, pruneMaxCount: 0 })).status).toBe(200);
  });

  it('applies the concurrency to the queue at once', async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const spy: number[] = [];
    const original = t.executions.setMaxConcurrent.bind(t.executions);
    t.executions.setMaxConcurrent = (n: number) => {
      spy.push(n);
      original(n);
    };
    await agent.patch('/api/settings').send({ maxConcurrentExecutions: 9 });
    await agent.patch('/api/settings').send({ maxConcurrentExecutions: 0 });
    expect(spy).toEqual([9, t.ctx.config.maxConcurrentExecutions]);
  });

  it('the timezone setting changes $now; the workflow setting still wins', async () => {
    t = await makeTestApp({ timezone: 'UTC' });
    const agent = await signedIn(t);
    const zone = async () => (await runExpr(agent, '={{ $now.zoneName }}')).output[0]![0]!.v;
    expect(await zone()).toBe('UTC');
    await agent.patch('/api/settings').send({ timezone: 'Asia/Tokyo' });
    expect(await zone()).toBe('Asia/Tokyo');
    const nodes = [node('Start', 'manualTrigger'), node('Calc', 'set', { assignments: { assignments: [{ name: 'v', value: '={{ $now.zoneName }}', type: 'string' }] } })];
    const own = (await agent.post('/api/dev/run').send({ name: 'W', nodes, connections: chain('Start', 'Calc'), settings: { timezone: 'America/New_York' } })).body;
    expect(own.output[0][0].v).toBe('America/New_York');
  });

  it('$env can be switched on and off in Settings (secrets stay hidden)', async () => {
    t = await makeTestApp({ allowEnvAccess: false });
    process.env.FF_TEST_VISIBLE = 'hello';
    process.env.FF_TEST_SECRET_KEY = 'nope';
    try {
      const agent = await signedIn(t);
      expect((await runExpr(agent, '={{ $env.FF_TEST_VISIBLE }}')).status).toBe('error');
      await agent.patch('/api/settings').send({ allowEnvAccess: true });
      expect((await runExpr(agent, '={{ $env.FF_TEST_VISIBLE }}')).output[0]![0]!.v).toBe('hello');
      expect((await runExpr(agent, '={{ $env.FF_TEST_SECRET_KEY }}')).output[0]![0]!.v).toBe('');
      await agent.patch('/api/settings').send({ allowEnvAccess: false });
      expect((await runExpr(agent, '={{ $env.FF_TEST_VISIBLE }}')).status).toBe('error');
    } finally {
      delete process.env.FF_TEST_VISIBLE;
      delete process.env.FF_TEST_SECRET_KEY;
    }
  });

  it('save-data defaults drop finished production runs; manual runs and own workflow settings are respected', async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const kept = async (mode: 'manual' | 'trigger', settings?: Record<string, unknown>) => {
      const nodes = [node('Start', 'manualTrigger'), node('Calc', 'set', { assignments: { assignments: [{ name: 'v', value: '1', type: 'string' }] } })];
      const res = await agent.post(`/api/dev/run?mode=${mode}`).send({ name: 'W', nodes, connections: chain('Start', 'Calc'), ...(settings ? { settings } : {}) });
      return Boolean(t!.ctx.executionsRepo.get(res.body.executionId as string));
    };
    expect(await kept('trigger')).toBe(true);
    await agent.patch('/api/settings').send({ saveDataSuccess: 'none' });
    expect(await kept('trigger')).toBe(false);
    expect(await kept('manual')).toBe(true);
    expect(await kept('trigger', { saveDataSuccessExecution: 'all' })).toBe(true);
    await agent.patch('/api/settings').send({ saveDataSuccess: 'all' });
    expect(await kept('trigger', { saveDataSuccessExecution: 'none' })).toBe(false);
  });
});
