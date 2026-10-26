import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionDetail, WorkflowNode } from '@flowforge/shared';
import { makeTestApp, waitFor, type TestApp } from './helpers.js';
import { startOpenMeteoMock, type OpenMeteoMock } from './open-meteo-mock.js';
import { activate, executions, finished, node, signedIn, type Agent } from './trigger-helpers.js';
import { MissingCredentialError } from '../src/engine/errors.js';
import { out, run, wf } from './engine-helpers.js';
import { showcaseWorkflow } from '../src/demo/showcase.js';

let t: TestApp;
let agent: Agent;
let meteo: OpenMeteoMock;

beforeEach(async () => {
  meteo = await startOpenMeteoMock();
  t = await makeTestApp();
  agent = await signedIn(t);
});
afterEach(async () => {
  await t.close();
  await meteo.close();
});

/** Builds the demo workflow and points Open-Meteo at the local mock (no real network in tests). */
async function build() {
  const res = await agent.post('/api/demo/build').send({});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const nodes = (res.body.workflow.nodes as WorkflowNode[]).map((n) =>
    n.type === 'flowforge.openMeteo' ? { ...n, parameters: { ...n.parameters, options: { forecastUrl: meteo.forecastUrl, geocodingUrl: meteo.geocodingUrl } } } : n,
  );
  const put = await agent.put(`/api/workflows/${res.body.workflowId}`).send({ name: res.body.workflow.name, nodes, connections: res.body.workflow.connections });
  expect(put.status, JSON.stringify(put.body)).toBe(200);
  return { ...res.body, nodes } as { workflowId: string; source: string; label: string; warnings: string[]; nodes: WorkflowNode[] };
}

const runOf = (e: ExecutionDetail, type: string, nodes: WorkflowNode[]) => {
  const name = nodes.find((n) => n.type === `flowforge.${type}`)!.name;
  return e.runData[name]?.at(-1);
};

describe('POST /api/demo/*', () => {
  it('needs a login', async () => {
    for (const path of ['build', 'listen', 'simulate-submission']) {
      expect((await request(t.app).post(`/api/demo/${path}`).send({})).status).toBe(401);
    }
  });

  it('builds a complete workflow without a Gemini key (offline or showcase), tagged demo', async () => {
    const built = await build();
    expect(['offline', 'showcase']).toContain(built.source);
    for (const type of ['formTrigger', 'openMeteo', 'sendEmail', 'telegram', 'discord']) {
      expect(built.nodes.some((n) => n.type === `flowforge.${type}`), type).toBe(true);
    }
    const tags = t.ctx.tagsRepo.forWorkflow(built.workflowId);
    expect(tags.map((x) => x.name)).toContain('demo');
  });

  it('listens, simulates a submission over HTTP, and the run is simulated (no keys)', async () => {
    const built = await build();
    const listen = await agent.post('/api/demo/listen').send({ workflowId: built.workflowId });
    expect(listen.status, JSON.stringify(listen.body)).toBe(200);
    expect(listen.body.formUrl).toContain('/form-test/');
    const sim = await agent.post('/api/demo/simulate-submission').send({ workflowId: built.workflowId, testUrl: listen.body.testUrl });
    expect(sim.status, JSON.stringify(sim.body)).toBe(200);
    const e = await finished(t, sim.body.executionId, 10000);
    expect(e.status).toBe('success');
    for (const type of ['sendEmail', 'telegram', 'discord']) {
      const run = runOf(e, type, built.nodes)!;
      expect(run.status, type).toBe('success');
      expect(run.simulated, type).toBe(true);
      expect(run.data.main[0]![0]!.json._simulated, type).toBe(true);
    }
    const weather = runOf(e, 'openMeteo', built.nodes)!;
    expect(weather.simulated).toBeFalsy();
    const email = runOf(e, 'sendEmail', built.nodes)!.data.main[0]![0]!.json;
    expect(email.accepted).toEqual(['demo@example.com']);
    expect(JSON.stringify(e)).not.toMatch(/password|apiKey|accessToken/i);
  });

  it('simulate-submission also works without a prior listen', async () => {
    const built = await build();
    const sim = await agent.post('/api/demo/simulate-submission').send({ workflowId: built.workflowId });
    expect(sim.status, JSON.stringify(sim.body)).toBe(200);
    expect((await finished(t, sim.body.executionId, 10000)).status).toBe('success');
  });

  it('refuses workflows that Demo Mode did not create', async () => {
    const res = await agent.post('/api/workflows').send({ name: 'Mine', nodes: [node('F', 'formTrigger', { formFields: { values: [] } })], connections: {} });
    const r = await agent.post('/api/demo/listen').send({ workflowId: res.body.id });
    expect(r.status).toBe(403);
  });
});

describe('demo flag security', () => {
  async function sameWorkflowNormally() {
    const built = await build();
    const showcase = built.nodes;
    return { id: built.workflowId, showcase };
  }

  it('the same workflow run normally fails with MissingCredentialError and is never simulated', async () => {
    const { id, showcase } = await sameWorkflowNormally();
    const trigger = showcase.find((n) => n.type === 'flowforge.formTrigger')!;
    // Normal manual run, even when the body tries to smuggle a demo flag.
    const res = await agent.post('/api/executions/run').send({ workflow: { id, name: 'x', nodes: showcase, connections: t.ctx.workflowsRepo.get(id)!.connections, pinData: { [trigger.name]: [{ json: { Name: 'A', Email: 'a@b.co', City: 'Paris' } }] } }, startNode: trigger.name, demo: true });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const e = await finished(t, res.body.executionId ?? executions(t, id)[0]!.id, 10000);
    const mailNode = showcase.find((n) => n.type === 'flowforge.sendEmail')!;
    const run = e.runData[mailNode.name]?.at(-1);
    expect(run).toBeDefined();
    expect(run?.simulated).toBeFalsy();
    expect(JSON.stringify(run?.data.main[0])).not.toContain('_simulated');
    expect(JSON.stringify(run)).toMatch(/credentials are missing/i);
  });

  it('a demo flag inside the workflow JSON is ignored', async () => {
    const wf = showcaseWorkflow();
    const nodes = wf.nodes.map((n) => ({ ...n, demo: true, parameters: { ...n.parameters, demo: true, ...(n.type === 'flowforge.openMeteo' ? { options: { forecastUrl: meteo.forecastUrl, geocodingUrl: meteo.geocodingUrl } } : {}) } })) as unknown as WorkflowNode[];
    const created = await agent.post('/api/workflows').send({ name: 'Smuggle', nodes, connections: wf.connections, settings: { demo: true } });
    const trigger = nodes[0]!;
    const res = await agent.post('/api/executions/run').send({ workflow: { id: created.body.id, name: 'x', nodes, connections: wf.connections, settings: { demo: true }, pinData: { [trigger.name]: [{ json: { Name: 'A', Email: 'a@b.co', City: 'Paris' } }] } }, startNode: trigger.name, demo: true });
    const e = await finished(t, res.body.executionId ?? executions(t, created.body.id)[0]!.id, 10000);
    expect(e.runData[nodes[3]!.name]?.at(-1)?.error?.message).toMatch(/credentials are missing/i);
    expect(JSON.stringify(e.runData)).not.toContain('_simulated');
  });
});

describe('runner: demo flag', () => {
  const missing = { resolve: () => { throw new MissingCredentialError('smtp', 'SMTP'); } };
  const workflow = () =>
    wf(
      [
        ['Start', 'manual'],
        ['Mail', 'flowforge.sendEmail', { toEmail: 'a@b.co', subject: 'x', emailFormat: 'text', message: 'hi' }, { onError: 'continueRegularOutput' }],
      ],
      [['Start', 'Mail']],
    );

  it('demo: a missing credential becomes simulated output (even with "continue on error")', async () => {
    const r = await run(workflow(), { demo: true }, {}, { credentials: missing as never });
    expect(r.status).toBe('success');
    const runRec = r.runData.Mail![0]!;
    expect(runRec.status).toBe('success');
    expect(runRec.simulated).toBe(true);
    expect(out(r, 'Mail')[0]).toMatchObject({ _simulated: true, accepted: ['a@b.co'] });
  });

  it('not demo: the same run fails with the clear MissingCredentialError message', async () => {
    const strict = workflow();
    delete strict.nodes[1]!.onError;
    const r = await run(strict, {}, {}, { credentials: missing as never });
    expect(r.status).toBe('error');
    expect(r.runData.Mail![0]!.simulated).toBeUndefined();
    expect(r.runData.Mail![0]!.error?.message).toBe('SMTP credentials are missing');
  });

  it('demo: any other error stays an error', async () => {
    const r = await run(wf([['Start', 'manual'], ['Boom', 'stop', { errorMessage: 'real failure' }]], [['Start', 'Boom']]), { demo: true });
    expect(r.status).toBe('error');
    expect(r.runData.Boom![0]!.simulated).toBeUndefined();
    expect(r.runData.Boom![0]!.error?.message).toContain('real failure');
  });
});

describe('demo listener', () => {
  it('a normal test-listen does not mark executions as demo', async () => {
    const built = await build();
    const trigger = built.nodes.find((n) => n.type === 'flowforge.formTrigger')!;
    const listen = await agent.post(`/api/workflows/${built.workflowId}/test-listen`).send({ nodeName: trigger.name, workflow: { name: 'x', nodes: built.nodes, connections: t.ctx.workflowsRepo.get(built.workflowId)!.connections } });
    expect(listen.status, JSON.stringify(listen.body)).toBe(200);
    const path = new URL(listen.body.testUrl).pathname;
    await request(t.app).post(path).type('form').set('Accept', 'application/json').send({ 'field-0': 'A', 'field-1': 'a@b.co', 'field-2': 'Paris' });
    const list = await waitFor(() => (executions(t, built.workflowId).length ? executions(t, built.workflowId) : undefined), 5000, 'execution');
    const e = await finished(t, list[0]!.id, 10000);
    const mail = built.nodes.find((n) => n.type === 'flowforge.sendEmail')!;
    expect(e.runData[mail.name]?.at(-1)?.simulated).toBeFalsy();
  });
});
