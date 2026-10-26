import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TemplateDetail, TemplateInfo, WorkflowRecord } from '@flowforge/shared';
import { WorkflowBodySchema } from '../src/api/schemas.js';
import { TEMPLATES_DIR } from '../src/templates/index.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { signedIn, type Agent } from './trigger-helpers.js';

let t: TestApp;
let agent: Agent;
beforeEach(async () => {
  t = await makeTestApp();
  agent = await signedIn(t);
});
afterEach(() => t.close());

const list = async (qs = '') => (await agent.get(`/api/templates${qs}`).expect(200)).body as TemplateInfo[];

describe('templates API', () => {
  it('requires a session', async () => {
    await request(t.app).get('/api/templates').expect(401);
    await request(t.app).get('/api/dashboard').expect(401);
  });

  it('lists examples, the new templates and the built-in ones', async () => {
    const all = await list();
    expect(all.filter((x) => x.source === 'example')).toHaveLength(readdirSync(join(TEMPLATES_DIR, '..', 'examples')).filter((f) => f.endsWith('.json')).length);
    const own = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.json'));
    expect(own.length).toBeGreaterThanOrEqual(6);
    for (const f of own) expect(all.some((x) => x.id === `template:${f.slice(0, -5)}`)).toBe(true);
    expect(all.some((x) => x.id.startsWith('template:builtin-'))).toBe(true);
    for (const x of all) {
      expect(x.name, x.id).toBeTruthy();
      expect(x.categories.length, x.id).toBeGreaterThan(0);
      expect(x.nodeCount, x.id).toBeGreaterThan(0);
    }
  });

  it('filters by search text and category', async () => {
    const telegram = await list('?q=telegram');
    expect(telegram.length).toBeGreaterThan(0);
    expect(telegram.every((x) => /telegram/i.test(`${x.name} ${x.description} ${x.nodeTypes.join(' ')}`))).toBe(true);
    const forms = await list('?category=forms');
    expect(forms.length).toBeGreaterThan(0);
    expect(forms.every((x) => x.categories.includes('Forms'))).toBe(true);
    expect(await list('?q=zzzznothing')).toEqual([]);
  });

  it('every template validates, uses registered node types and imports', async () => {
    const all = await list();
    for (const info of all) {
      const detail = (await agent.get(`/api/templates/${encodeURIComponent(info.id)}`).expect(200)).body as TemplateDetail;
      expect(() => WorkflowBodySchema.parse({ name: detail.name, nodes: detail.nodes, connections: detail.connections }), info.id).not.toThrow();
      const names = new Set(detail.nodes.map((n) => n.name));
      for (const n of detail.nodes) expect(t.ctx.registry.get(n.type), `${info.id}: ${n.type}`).toBeDefined();
      for (const [from, byType] of Object.entries(detail.connections)) {
        expect(names.has(from), `${info.id}: ${from}`).toBe(true);
        for (const lists of Object.values(byType)) for (const l of lists ?? []) for (const c of l) expect(names.has(c.node), `${info.id}: ${c.node}`).toBe(true);
      }
      const res = await agent.post(`/api/templates/${encodeURIComponent(info.id)}/import`).expect(201);
      const wf = res.body as WorkflowRecord;
      expect(wf.active).toBe(false);
      expect(wf.nodes.length).toBe(detail.nodes.length);
    }
  });

  it('gives each import a unique name and fresh webhook ids', async () => {
    const id = encodeURIComponent('template:webhook-to-telegram');
    const a = (await agent.post(`/api/templates/${id}/import`).expect(201)).body as WorkflowRecord;
    const b = (await agent.post(`/api/templates/${id}/import`).expect(201)).body as WorkflowRecord;
    expect(a.name).not.toBe(b.name);
    expect(a.nodes.find((n) => n.webhookId)?.webhookId).not.toBe(b.nodes.find((n) => n.webhookId)?.webhookId);
  });

  it('imports a multi-workflow example from the gallery with its references rewritten', async () => {
    const detail = (await agent.get('/api/templates/example:resilience-demo').expect(200)).body as TemplateDetail;
    expect(detail.nodeTypes).toContain('flowforge.errorTrigger');
    const main = (await agent.post('/api/templates/example:resilience-demo/import').expect(201)).body as WorkflowRecord;
    const all = (await agent.get('/api/workflows').expect(200)).body as { id: string; name: string }[];
    const handler = all.find((w) => w.name === 'Resilience: error handler');
    expect(handler).toBeDefined();
    expect(main.settings?.errorWorkflow).toBe(handler!.id);
    const sub = all.find((w) => w.name.startsWith('Resilience: calculate price'))!;
    expect(main.nodes.find((n) => n.type === 'flowforge.executeWorkflow')!.parameters.workflowId).toBe(sub.id);
  });

  it('answers 404 for unknown templates', async () => {
    await agent.get('/api/templates/template:nope').expect(404);
    await agent.post('/api/templates/example:nope/import').expect(404);
  });

  it('keeps the template folder free of secrets', () => {
    expect(existsSync(TEMPLATES_DIR)).toBe(true);
    for (const f of readdirSync(TEMPLATES_DIR)) expect(readFileSync(join(TEMPLATES_DIR, f), 'utf8')).not.toMatch(/AIza|xox[bp]-|Bearer [A-Za-z0-9]{10,}|\d{8,}:[A-Za-z0-9_-]{30,}/);
  });
});
