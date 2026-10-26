import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowNode, WorkflowRecord, WorkflowVersionDetail, WorkflowVersionSummary } from '@flowforge/shared';
import { MAX_VERSIONS } from '../src/db/repositories/versions.js';
import { makeTestApp, OWNER, type TestApp } from './helpers.js';

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

const node = (id: string, name: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id, name, type: 'flowforge.noOp', typeVersion: 1, position: [0, 0], parameters: {}, ...extra,
});
const body = (name: string, nodes: WorkflowNode[], extra: object = {}) => ({ name, nodes, connections: {}, ...extra });
const list = async (id: string) => (await agent.get(`/api/workflows/${id}/versions`)).body as WorkflowVersionSummary[];

describe('workflow versions', () => {
  it('requires login', async () => {
    expect((await request(t.app).get('/api/workflows/x/versions')).status).toBe(401);
    expect((await request(t.app).post('/api/workflows/x/versions/1/restore')).status).toBe(401);
  });

  it('records on create, skips identical saves, records changes with a note', async () => {
    const wf = (await agent.post('/api/workflows').send(body('W', [node('1', 'A')]))).body as WorkflowRecord;
    expect(await list(wf.id)).toHaveLength(1);
    await agent.put(`/api/workflows/${wf.id}`).send(body('W', [node('1', 'A')]));
    expect(await list(wf.id)).toHaveLength(1);
    // pinData changes alone do not create a version
    await agent.put(`/api/workflows/${wf.id}`).send(body('W', [node('1', 'A')], { pinData: { A: [{ json: { a: 1 } }] } }));
    expect(await list(wf.id)).toHaveLength(1);
    await agent.put(`/api/workflows/${wf.id}`).send(body('W', [node('1', 'A'), node('2', 'B')], { versionNote: 'added B' }));
    const versions = await list(wf.id);
    expect(versions.map((v) => v.number)).toEqual([2, 1]);
    expect(versions[0]!).toMatchObject({ source: 'save', note: 'added B', nodeCount: 2 });
    expect(versions[0]!.diff.added).toEqual(['B']);
    expect(versions[1]!.source).toBe('create');
  });

  it('rename via PATCH does not record; the next save does', async () => {
    const wf = (await agent.post('/api/workflows').send(body('W', [node('1', 'A')]))).body as WorkflowRecord;
    await agent.patch(`/api/workflows/${wf.id}`).send({ name: 'Renamed' });
    expect(await list(wf.id)).toHaveLength(1);
    await agent.put(`/api/workflows/${wf.id}`).send(body('Renamed', [node('1', 'A')]));
    const v = await list(wf.id);
    expect(v).toHaveLength(2);
    expect(v[0]!.diff.nameChanged).toBe(true);
  });

  it('restore creates a new version, keeps pinData, edits the note', async () => {
    const wf = (await agent.post('/api/workflows').send(body('W', [node('1', 'A')]))).body as WorkflowRecord;
    await agent.put(`/api/workflows/${wf.id}`).send(body('W2', [node('1', 'A'), node('2', 'B')], { pinData: { A: [{ json: { k: 1 } }] } }));
    const res = await agent.post(`/api/workflows/${wf.id}/versions/1/restore`).send({});
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('W');
    expect(res.body.nodes).toHaveLength(1);
    expect(res.body.pinData).toEqual({ A: [{ json: { k: 1 } }] });
    const v = await list(wf.id);
    expect(v.map((x) => x.number)).toEqual([3, 2, 1]);
    expect(v[0]!).toMatchObject({ source: 'restore', restoredFrom: 1 });
    expect(v[0]!.diff.removed).toEqual(['B']);
    const patched = await agent.patch(`/api/workflows/${wf.id}/versions/3`).send({ note: 'back' });
    expect(patched.body.note).toBe('back');
    expect((await agent.patch(`/api/workflows/${wf.id}/versions/3`).send({ note: 'x'.repeat(201) })).status).toBe(400);
  });

  it('404s, bad numbers and cascade on delete', async () => {
    const wf = (await agent.post('/api/workflows').send(body('W', [node('1', 'A')]))).body as WorkflowRecord;
    expect((await agent.get('/api/workflows/nope/versions')).status).toBe(404);
    expect((await agent.get(`/api/workflows/${wf.id}/versions/9`)).status).toBe(404);
    expect((await agent.post(`/api/workflows/${wf.id}/versions/9/restore`).send({})).status).toBe(404);
    expect((await agent.get(`/api/workflows/${wf.id}/versions/abc`)).status).toBe(400);
    expect((await agent.get(`/api/workflows/${wf.id}/versions/0`)).status).toBe(400);
    await agent.delete(`/api/workflows/${wf.id}`);
    const count = t.ctx.db.prepare('SELECT COUNT(*) AS c FROM workflow_versions').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('keeps at most 100 versions', async () => {
    const wf = (await agent.post('/api/workflows').send(body('W', []))).body as WorkflowRecord;
    for (let i = 0; i < MAX_VERSIONS + 5; i++) await agent.put(`/api/workflows/${wf.id}`).send(body(`W${i}`, []));
    const v = await list(wf.id);
    expect(v).toHaveLength(MAX_VERSIONS);
    expect(v[0]!.number).toBe(MAX_VERSIONS + 6);
  });

  it('never exposes credential secrets (only id/name references)', async () => {
    const SECRET = 'sup3r-secret-pw-XYZ';
    const cred = (await agent.post('/api/credentials').send({ name: 'Mail', type: 'smtp', data: { host: 'h', port: 25, user: 'u', password: SECRET } })).body;
    const wf = (await agent.post('/api/workflows').send(body('W', [node('1', 'A', { credentials: { smtp: { id: cred.id, name: 'Mail' } } })]))).body as WorkflowRecord;
    const all = await agent.get(`/api/workflows/${wf.id}/versions`);
    const one = await agent.get(`/api/workflows/${wf.id}/versions/1`);
    expect(JSON.stringify([all.body, one.body])).not.toContain(SECRET);
    expect((one.body as WorkflowVersionDetail).nodes[0]!.credentials).toEqual({ smtp: { id: cred.id, name: 'Mail' } });
  });
});
