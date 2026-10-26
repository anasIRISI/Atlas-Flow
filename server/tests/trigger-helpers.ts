import request from 'supertest';
import type { ExecutionDetail, JsonObject, WorkflowData } from '@flowforge/shared';
import { OWNER, waitFor, type TestApp } from './helpers.js';

export type Agent = ReturnType<typeof request.agent>;

export async function signedIn(t: TestApp): Promise<Agent> {
  const agent = request.agent(t.app);
  await agent.post('/api/auth/setup').send(OWNER);
  return agent;
}

let n = 0;
/** Short node builder. */
export const node = (name: string, type: string, parameters: JsonObject = {}, extra: JsonObject = {}) => ({
  id: `n${++n}`,
  name,
  type: type.includes('.') ? type : `flowforge.${type}`,
  typeVersion: 1,
  position: [n * 200, 0] as [number, number],
  parameters,
  ...extra,
});

/** a → b → c… main connections (output 0, input 0). */
export function chain(...names: string[]): WorkflowData['connections'] {
  const c: WorkflowData['connections'] = {};
  for (let i = 0; i < names.length - 1; i++) c[names[i]!] = { main: [[{ node: names[i + 1]!, type: 'main', index: 0 }]] };
  return c;
}

export async function createWorkflow(agent: Agent, body: Partial<WorkflowData>): Promise<string> {
  const res = await agent.post('/api/workflows').send(body);
  if (res.status !== 201) throw new Error(`create failed: ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

export async function activate(agent: Agent, id: string) {
  return agent.post(`/api/workflows/${id}/activate`).send({});
}

export function executions(t: TestApp, workflowId?: string) {
  return t.ctx.executionsRepo.list({ limit: 500, workflowId });
}

export async function finished(t: TestApp, id: string, timeoutMs = 5000): Promise<ExecutionDetail> {
  return waitFor(
    () => {
      const e = t.ctx.executionsRepo.get(id);
      return e && !['queued', 'running'].includes(e.status) ? e : undefined;
    },
    timeoutMs,
    `execution ${id}`,
  );
}

/** Output JSON of the last run of a node. */
export const output = (e: ExecutionDetail, nodeName: string, outputIndex = 0) => {
  const runs = e.runData[nodeName];
  return (runs?.[runs.length - 1]?.data.main[outputIndex] ?? []).map((i) => i.json);
};
