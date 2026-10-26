import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DashboardStats } from '@flowforge/shared';
import { lastDays } from '../src/api/dashboard.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { signedIn, type Agent } from './trigger-helpers.js';

let t: TestApp;
let agent: Agent;
beforeEach(async () => {
  t = await makeTestApp({ timezone: 'Europe/Paris' });
  agent = await signedIn(t);
});
afterEach(() => t.close());

const stats = async () => (await agent.get('/api/dashboard').expect(200)).body as DashboardStats;

function addExecution(o: { workflowId?: string | null; name: string; status: string; at: Date; durationMs?: number; error?: string }) {
  const started = o.at.toISOString();
  const stopped = o.durationMs === undefined ? null : new Date(o.at.getTime() + o.durationMs).toISOString();
  t.ctx.db
    .prepare(`INSERT INTO executions (workflow_id, workflow_name, mode, status, created_at, started_at, stopped_at, error_message) VALUES (?, ?, 'trigger', ?, ?, ?, ?, ?)`)
    .run(o.workflowId ?? null, o.name, o.status, started, started, stopped, o.error ?? null);
}

describe('GET /api/dashboard', () => {
  it('returns 14 zero days and empty lists on a fresh instance', async () => {
    const s = await stats();
    expect(s.perDay).toHaveLength(14);
    expect(s.perDay.every((d) => d.success + d.error + d.other === 0)).toBe(true);
    expect(s.successRate).toBeNull();
    expect(s.avgDurationMs).toBeNull();
    expect(s.topFailing).toEqual([]);
    expect(s.recent).toEqual([]);
    expect(s.workflows).toEqual({ total: 0, active: 0 });
    expect(s.integrations.length).toBeGreaterThan(0);
  });

  it('counts per day, success rate, average duration and top failing workflows', async () => {
    const now = Date.now();
    const h = 3_600_000;
    addExecution({ workflowId: 'w1', name: 'Alpha', status: 'success', at: new Date(now - 1 * h), durationMs: 1000 });
    addExecution({ workflowId: 'w1', name: 'Alpha', status: 'success', at: new Date(now - 2 * h), durationMs: 3000 });
    addExecution({ workflowId: 'w2', name: 'Beta', status: 'error', at: new Date(now - 3 * h), durationMs: 500, error: 'boom one' });
    addExecution({ workflowId: 'w2', name: 'Beta', status: 'error', at: new Date(now - 4 * h), durationMs: 500, error: 'boom two' });
    addExecution({ workflowId: 'w3', name: 'Gamma', status: 'error', at: new Date(now - 5 * h), durationMs: 500, error: 'bad' });
    addExecution({ workflowId: 'w3', name: 'Gamma', status: 'waiting', at: new Date(now - 5 * h) });
    addExecution({ workflowId: 'w1', name: 'Old', status: 'success', at: new Date(now - 40 * 24 * h), durationMs: 1 });
    const s = await stats();
    expect(s.totals).toMatchObject({ executions: 6, success: 2, error: 3, waiting: 1 });
    expect(s.successRate).toBeCloseTo(2 / 5);
    expect(s.avgDurationMs).toBe(Math.round((1000 + 3000 + 500 * 3) / 5));
    expect(s.perDay.reduce((n, d) => n + d.success + d.error + d.other, 0)).toBe(6);
    expect(s.topFailing[0]).toMatchObject({ workflowId: 'w2', workflowName: 'Beta', errors: 2, lastError: 'boom two' });
    expect(s.topFailing[1]).toMatchObject({ workflowId: 'w3', errors: 1 });
    expect(s.recent).toHaveLength(7);
    expect(s.recent[0]).toMatchObject({ workflowName: 'Old', durationMs: 1 });
    expect(s.recent[1]!.durationMs).toBe(null);
  });

  it('computes days in the instance timezone', () => {
    const noon = Date.parse('2026-03-10T23:30:00Z');
    expect(lastDays(noon, 'Europe/Paris', 3).at(-1)).toBe('2026-03-11');
    expect(lastDays(noon, 'UTC', 3).at(-1)).toBe('2026-03-10');
    expect(lastDays(noon, 'Asia/Tokyo', 14)).toHaveLength(14);
  });

  it('reports credentials and workflows without exposing secrets', async () => {
    const secret = 'sk-super-secret-value-123';
    await agent.post('/api/credentials').send({ name: 'My Gemini', type: 'googlePalmApi', data: { apiKey: secret } }).expect(201);
    await agent.post('/api/workflows').send({ name: 'W', nodes: [], connections: {} }).expect(201);
    const res = await agent.get('/api/dashboard').expect(200);
    expect(JSON.stringify(res.body)).not.toContain(secret);
    const s = res.body as DashboardStats;
    expect(s.integrations.find((i) => i.type === 'googlePalmApi')).toMatchObject({ count: 1, fromEnv: false });
    expect(s.integrations.find((i) => i.type === 'smtp')).toMatchObject({ count: 0 });
    expect(s.workflows.total).toBe(1);
  });
});
