import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionMode, ExecutionStatus, WorkflowData } from '@flowforge/shared';
import { pruneExecutions, type PruneSettings } from '../src/engine/pruning.js';
import { makeTestApp, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeTestApp();
});
afterEach(async () => {
  await t.close();
});

const wf: WorkflowData = { name: 'W', nodes: [], connections: {} };
const DAY = 86_400_000;
const none: PruneSettings = { pruneMaxAgeDays: 0, pruneMaxCount: 0, saveDataManual: 'all' };
const deps = () => ({ repo: t.ctx.executionsRepo, binaryStore: t.ctx.binaryStore });

/** Creates an execution with the given status and age. */
function make(status: ExecutionStatus, ageDays: number, mode: ExecutionMode = 'webhook', ageMs = ageDays * DAY): string {
  const id = t.ctx.executionsRepo.create({ workflow: wf, mode });
  t.ctx.db.prepare('UPDATE executions SET status = ?, created_at = ? WHERE id = ?').run(status, new Date(Date.now() - ageMs).toISOString(), Number(id));
  return id;
}
const exists = (id: string) => t.ctx.executionsRepo.get(id) !== undefined;

describe('pruneExecutions', () => {
  it('deletes finished executions older than the max age', async () => {
    const old = make('success', 30);
    const oldErr = make('error', 20);
    const fresh = make('success', 1);
    expect(await pruneExecutions(deps(), { ...none, pruneMaxAgeDays: 14 })).toBe(2);
    expect([exists(old), exists(oldErr), exists(fresh)]).toEqual([false, false, true]);
  });

  it('keeps only the newest N finished executions', async () => {
    const ids = [make('success', 0), make('error', 0), make('success', 0), make('crashed', 0)];
    expect(await pruneExecutions(deps(), { ...none, pruneMaxCount: 2 })).toBe(2);
    expect(ids.map(exists)).toEqual([false, false, true, true]);
  });

  it('NEVER deletes queued, running or waiting executions, however old or numerous', async () => {
    const active = (['queued', 'running', 'waiting'] as const).map((s) => make(s, 400));
    const finished = make('success', 400);
    expect(await pruneExecutions(deps(), { pruneMaxAgeDays: 1, pruneMaxCount: 1, saveDataManual: 'none' })).toBe(1);
    expect(active.map(exists)).toEqual([true, true, true]);
    expect(exists(finished)).toBe(false);
  });

  it('removes manual executions older than 10 minutes when manual data is not saved', async () => {
    const recent = make('success', 0, 'manual', 2 * 60_000);
    const stale = make('success', 0, 'manual', 11 * 60_000);
    const running = make('running', 0, 'manual', 60 * 60_000);
    const production = make('success', 0, 'webhook', 60 * 60_000);
    expect(await pruneExecutions(deps(), { ...none, saveDataManual: 'none' })).toBe(1);
    expect([exists(recent), exists(stale), exists(running), exists(production)]).toEqual([true, false, true, true]);
    // With the default policy manual executions stay.
    const keep = make('success', 0, 'manual', 60 * 60_000);
    expect(await pruneExecutions(deps(), none)).toBe(0);
    expect(exists(keep)).toBe(true);
  });

  it('0 means no limit, and nothing happens on an empty table', async () => {
    expect(await pruneExecutions(deps(), none)).toBe(0);
    const id = make('success', 5000);
    expect(await pruneExecutions(deps(), none)).toBe(0);
    expect(exists(id)).toBe(true);
  });

  it('deletes the binary data of pruned executions', async () => {
    const id = make('success', 30);
    const ref = await t.ctx.binaryStore.store(id, Buffer.from('hello'), 'a.txt', 'text/plain');
    expect(t.ctx.binaryStore.exists(ref.id)).toBe(true);
    await pruneExecutions(deps(), { ...none, pruneMaxAgeDays: 14 });
    expect(t.ctx.binaryStore.exists(ref.id)).toBe(false);
  });
});
