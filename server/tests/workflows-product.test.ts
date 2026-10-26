import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyName, sanitizeCredentialRefs, slugify, unwrapImport } from '../src/workflows/transfer.js';
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

const SECRET = 'S3cr3t-Pa55word-XYZ';
const node = (name: string, extra: object = {}) => ({ id: `id-${name}`, name, type: 'flowforge.noOp', typeVersion: 1, position: [0, 0], parameters: {}, ...extra });
const mkWorkflow = async (name: string, body: object = {}) => (await agent.post('/api/workflows').send({ name, ...body })).body;

describe('tags API', () => {
  it('requires login on every new route', async () => {
    for (const [m, p] of [
      ['get', '/api/tags'],
      ['post', '/api/tags'],
      ['patch', '/api/tags/x'],
      ['delete', '/api/tags/x'],
      ['put', '/api/workflows/x/tags'],
      ['post', '/api/workflows/x/duplicate'],
      ['get', '/api/workflows/x/export'],
      ['post', '/api/workflows/import'],
      ['post', '/api/workflows/delete'],
    ] as const) {
      expect((await request(t.app)[m](p).send({})).status, `${m} ${p}`).toBe(401);
    }
  });

  it('creates, lists with usage count, renames and deletes', async () => {
    const a = await agent.post('/api/tags').send({ name: '  prod ' });
    expect(a.status).toBe(201);
    expect(a.body.name).toBe('prod');
    expect((await agent.post('/api/tags').send({ name: 'PROD' })).status).toBe(409);
    expect((await agent.post('/api/tags').send({ name: '   ' })).status).toBe(400);
    expect((await agent.post('/api/tags').send({ name: 'x'.repeat(33) })).status).toBe(400);
    const b = (await agent.post('/api/tags').send({ name: 'dev' })).body;
    const wf = await mkWorkflow('W');
    await agent.put(`/api/workflows/${wf.id}/tags`).send({ tagIds: [a.body.id] });
    const list = (await agent.get('/api/tags')).body;
    expect(list.map((x: { name: string; usageCount: number }) => [x.name, x.usageCount])).toEqual([['dev', 0], ['prod', 1]]);
    expect((await agent.patch(`/api/tags/${b.id}`).send({ name: 'prod' })).status).toBe(409);
    expect((await agent.patch(`/api/tags/${b.id}`).send({ name: 'staging' })).body.name).toBe('staging');
    expect((await agent.patch('/api/tags/nope').send({ name: 'z' })).status).toBe(404);
    expect((await agent.delete(`/api/tags/${a.body.id}`)).status).toBe(204);
    expect((await agent.delete(`/api/tags/${a.body.id}`)).status).toBe(404);
    expect((await agent.get('/api/workflows')).body[0].tags).toEqual([]);
  });

  it('assigns tags to a workflow and exposes them in the list', async () => {
    const tag = (await agent.post('/api/tags').send({ name: 'ai' })).body;
    const wf = await mkWorkflow('Tagged');
    const res = await agent.put(`/api/workflows/${wf.id}/tags`).send({ tagIds: [tag.id, tag.id] });
    expect(res.body.tags).toEqual([{ id: tag.id, name: 'ai' }]);
    expect((await agent.put(`/api/workflows/${wf.id}/tags`).send({ tagIds: ['ghost'] })).status).toBe(400);
    expect((await agent.put('/api/workflows/missing/tags').send({ tagIds: [] })).status).toBe(404);
    const list = (await agent.get('/api/workflows')).body;
    expect(list[0]).toMatchObject({ name: 'Tagged', tags: [{ name: 'ai' }], lastExecutionStatus: null, lastExecutionAt: null });
    await agent.put(`/api/workflows/${wf.id}/tags`).send({ tagIds: [] });
    expect((await agent.get('/api/workflows')).body[0].tags).toEqual([]);
  });

  it('list carries the last execution status', async () => {
    const wf = await mkWorkflow('Run me', {
      nodes: [{ ...node('Start'), type: 'flowforge.manualTrigger' }],
    });
    const run = await agent.post('/api/executions/run').send({ workflowId: wf.id, workflow: wf });
    expect(run.status).toBeLessThan(300);
    let status: string | null = null;
    for (let i = 0; i < 100 && status !== 'success'; i++) {
      status = (await agent.get('/api/workflows')).body[0].lastExecutionStatus;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(status).toBe('success');
  });
});

describe('duplicate', () => {
  it('copies nodes, pinData and tags with fresh webhook ids, inactive, unique name, records a version', async () => {
    const tag = (await agent.post('/api/tags').send({ name: 'keep' })).body;
    const wf = await mkWorkflow('Original', { nodes: [node('Hook', { webhookId: 'abc-123' })], pinData: { Hook: [{ json: { a: 1 } }] } });
    await agent.put(`/api/workflows/${wf.id}/tags`).send({ tagIds: [tag.id] });
    const c1 = await agent.post(`/api/workflows/${wf.id}/duplicate`).send({});
    expect(c1.status).toBe(201);
    expect(c1.body).toMatchObject({ name: 'Original (copy)', active: false, pinData: { Hook: [{ json: { a: 1 } }] } });
    expect(c1.body.id).not.toBe(wf.id);
    expect(c1.body.nodes[0].webhookId).toBeTruthy();
    expect(c1.body.nodes[0].webhookId).not.toBe('abc-123');
    const c2 = await agent.post(`/api/workflows/${wf.id}/duplicate`).send({});
    expect(c2.body.name).toBe('Original (copy 2)');
    const list = (await agent.get('/api/workflows')).body as Array<{ id: string; tags: unknown[] }>;
    expect(list.find((w) => w.id === c1.body.id)!.tags).toHaveLength(1);
    const versions = t.ctx.db.prepare('SELECT source FROM workflow_versions WHERE workflow_id = ?').all(c1.body.id) as Array<{ source: string }>;
    expect(versions.map((v) => v.source)).toEqual(['create']);
    expect((await agent.post('/api/workflows/nope/duplicate').send({})).status).toBe(404);
  });
});

describe('export / import', () => {
  const credNode = (cid: string) => node('Call', { type: 'flowforge.httpRequest', credentials: { httpBasicAuth: { id: cid, name: 'My basic' } } });

  it('export never contains a saved credential secret; import resolves the reference', async () => {
    const cred = await agent.post('/api/credentials').send({ name: 'My basic', type: 'httpBasicAuth', data: { user: 'bob', password: SECRET } });
    expect(cred.status).toBeLessThan(300);
    const wf = await mkWorkflow('Has creds', { nodes: [credNode(cred.body.id)], pinData: { Call: [{ json: { token: SECRET } }] } });
    // A workflow saved with a hand-edited credential ref carrying a secret: still stripped.
    await agent.put(`/api/workflows/${wf.id}`).send({
      name: 'Has creds',
      nodes: [node('Call', { type: 'flowforge.httpRequest', credentials: { httpBasicAuth: { id: cred.body.id, name: 'My basic', password: SECRET } } })],
      connections: {},
    });
    const tag = (await agent.post('/api/tags').send({ name: 'shared' })).body;
    await agent.put(`/api/workflows/${wf.id}/tags`).send({ tagIds: [tag.id] });

    const exp = await agent.get(`/api/workflows/${wf.id}/export`);
    expect(exp.status).toBe(200);
    expect(exp.headers['content-disposition']).toBe('attachment; filename="has-creds.json"');
    expect(exp.text).not.toContain(SECRET);
    expect(exp.text).not.toContain('pinData');
    expect(exp.body.nodes[0].credentials).toEqual({ httpBasicAuth: { id: cred.body.id, name: 'My basic' } });
    expect(exp.body).toMatchObject({ name: 'Has creds', tags: ['shared'], meta: { exportedFrom: 'flowforge' } });

    const imp = await agent.post('/api/workflows/import').send(exp.body);
    expect(imp.status).toBe(201);
    expect(imp.body).toMatchObject({ name: 'Has creds 2', missingCredentials: [] });
    const loaded = (await agent.get(`/api/workflows/${imp.body.id}`)).body;
    expect(loaded.active).toBe(false);
    expect(loaded.nodes[0].credentials.httpBasicAuth.id).toBe(cred.body.id);
    expect(JSON.stringify(loaded)).not.toContain(SECRET);
    const list = (await agent.get('/api/workflows')).body as Array<{ id: string; tags: Array<{ name: string }> }>;
    expect(list.find((w) => w.id === imp.body.id)!.tags.map((x) => x.name)).toEqual(['shared']);
    const versions = t.ctx.db.prepare('SELECT source FROM workflow_versions WHERE workflow_id = ?').all(imp.body.id) as Array<{ source: string }>;
    expect(versions.map((v) => v.source)).toEqual(['import']);
  });

  it('resolves a reference by name when the id is unknown and reports missing ones', async () => {
    const cred = await agent.post('/api/credentials').send({ name: 'My basic', type: 'httpBasicAuth', data: { user: 'u', password: SECRET } });
    const file = {
      name: 'From elsewhere',
      nodes: [
        node('ByName', { type: 'flowforge.httpRequest', credentials: { httpBasicAuth: { id: 'foreign-id', name: 'My basic' } } }),
        node('Gone', { type: 'flowforge.httpRequest', credentials: { httpHeaderAuth: { id: 'x', name: 'Nope', value: 'leak' } } }),
      ],
      connections: {},
    };
    const imp = await agent.post('/api/workflows/import').send({ workflow: file });
    expect(imp.status).toBe(201);
    expect(imp.body.missingCredentials).toEqual([{ node: 'Gone', type: 'httpHeaderAuth', name: 'Nope' }]);
    const loaded = (await agent.get(`/api/workflows/${imp.body.id}`)).body;
    expect(loaded.nodes[0].credentials.httpBasicAuth.id).toBe(cred.body.id);
    expect(loaded.nodes[1].credentials.httpHeaderAuth).toEqual({ id: 'x', name: 'Nope' });
  });

  it('gives imported webhook nodes fresh ids and warns about unknown node types', async () => {
    const imp = await agent.post('/api/workflows/import').send({ name: 'W', nodes: [node('Hook', { webhookId: 'same' }), node('Odd', { type: 'n8n-nodes-base.unknown' })], connections: {} });
    expect(imp.body.warnings[0]).toContain('Odd');
    const loaded = (await agent.get(`/api/workflows/${imp.body.id}`)).body;
    expect(loaded.nodes[0].webhookId).not.toBe('same');
  });

  it('rejects bad input with a clear message', async () => {
    for (const body of [{}, { nodes: 'x' }, [], 'text', { name: 'a', nodes: [{ type: 'x' }] }, { nodes: [node('A'), node('A')] }, { nodes: [], connections: [] }]) {
      const res = await agent.post('/api/workflows/import').send(body as object);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.message).toBeTruthy();
    }
    const bad = await agent.post('/api/workflows/import').set('Content-Type', 'application/json').send('{not json');
    expect(bad.status).toBe(400);
    expect((await agent.get('/api/workflows/missing/export')).status).toBe(404);
  });
});

describe('bulk delete', () => {
  it('deletes many, ignores unknown ids, validates the body', async () => {
    const a = await mkWorkflow('A');
    const b = await mkWorkflow('B');
    const c = await mkWorkflow('C');
    const res = await agent.post('/api/workflows/delete').send({ ids: [a.id, b.id, 'ghost', a.id] });
    expect(res.body).toEqual({ deleted: 2 });
    expect((await agent.get('/api/workflows')).body.map((w: { id: string }) => w.id)).toEqual([c.id]);
    expect((await agent.post('/api/workflows/delete').send({ ids: [] })).status).toBe(400);
    expect((await agent.post('/api/workflows/delete').send({})).status).toBe(400);
    expect((await agent.post('/api/workflows/delete').send({ ids: Array(201).fill('x') })).status).toBe(400);
  });
});

describe('transfer helpers', () => {
  it('slugify, copyName, sanitize, unwrap', () => {
    expect(slugify('Mon Flux Été!')).toBe('mon-flux-ete');
    expect(slugify('***')).toBe('workflow');
    expect(copyName('A', ['A', 'A (copy)'])).toBe('A (copy 2)');
    expect(copyName('A (copy)', ['A', 'A (copy)'])).toBe('A (copy 2)');
    const n = sanitizeCredentialRefs({ ...node('x'), credentials: { t: { id: '1', name: 'n', password: 'p' } } } as never);
    expect(JSON.stringify(n)).not.toContain('"p"');
    expect(unwrapImport([{ nodes: [] }])).toEqual({ nodes: [] });
  });
});
