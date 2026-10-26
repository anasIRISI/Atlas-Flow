// Demo Mode server side. Contract: docs/phase8-contracts.md (W3)
import type { Connections, WorkflowData, WorkflowNode } from '@flowforge/shared';
import { buildWorkflow } from '../ai/builder/index.js';
import type { AppServices } from '../app.js';
import { EXAMPLES_DIR } from '../api/examples.js';
import { HttpError, notFound } from '../http/errors.js';
import { DEMO_PROMPT, DEMO_TAG, showcaseWorkflow } from './showcase.js';

export type DemoSource = 'gemini' | 'offline' | 'showcase';

export interface DemoBuildResult {
  workflowId: string;
  workflow: { name: string; nodes: WorkflowNode[]; connections: Connections };
  source: DemoSource;
  label: string;
  warnings: string[];
}

const REQUIRED = ['formTrigger', 'openMeteo', 'sendEmail', 'telegram', 'discord'];
const has = (nodes: WorkflowNode[], short: string) => nodes.some((n) => n.type === `flowforge.${short}`);
const complete = (nodes: WorkflowNode[]) => REQUIRED.every((t) => has(nodes, t));

function stamp(): string {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Builds (Gemini, offline template or showcase) and saves the demo workflow. */
export async function buildDemo(s: AppServices, prompt: string | undefined, showcaseOnly = false): Promise<DemoBuildResult> {
  const warnings: string[] = [];
  let workflow = showcaseWorkflow();
  let source: DemoSource = 'showcase';
  let label = 'Showcase workflow';
  try {
    if (showcaseOnly) throw new Error('showcase requested');
    const built = await buildWorkflow(prompt?.trim() || DEMO_PROMPT, { registry: s.registry, credentials: s.credentials, examplesDir: EXAMPLES_DIR, logger: s.logger });
    if (complete(built.workflow.nodes)) {
      workflow = built.workflow;
      source = built.source === 'ai' ? 'gemini' : 'offline';
      label = built.source === 'ai' ? 'Built with Gemini' : 'Offline: closest template';
    } else {
      warnings.push(built.source === 'ai' ? 'The AI result did not cover the whole demo, so the showcase workflow is used.' : 'No ready-made template covers the whole demo, so the showcase workflow is used.');
    }
    if (built.reason) warnings.push(built.reason);
  } catch (err) {
    if (!showcaseOnly) {
      s.logger.warn(`Demo: the builder failed (${(err as Error).message}); using the showcase workflow`);
      warnings.push('The AI builder is not available; the showcase workflow is used.');
    }
  }
  const created = s.workflowsRepo.create({ name: s.workflowsRepo.uniqueName(`Demo · ${stamp()}`), nodes: workflow.nodes, connections: workflow.connections, settings: {} });
  s.tagsRepo.setForWorkflow(created.id, [s.tagsRepo.ensure(DEMO_TAG).id]);
  return { workflowId: created.id, workflow: { name: created.name, nodes: workflow.nodes, connections: workflow.connections }, source, label, warnings };
}

function demoWorkflow(s: AppServices, id: string): WorkflowData & { id: string } {
  const wf = s.workflowsRepo.get(id);
  if (!wf) throw notFound('Workflow not found');
  // Only workflows made by Demo Mode can run as a demo.
  if (!s.tagsRepo.forWorkflow(id).some((t) => t.name === DEMO_TAG)) throw new HttpError(403, 'Only workflows created by Demo Mode can run in Demo Mode', 'not_a_demo_workflow');
  return wf as unknown as WorkflowData & { id: string };
}

const formNode = (wf: WorkflowData) => wf.nodes.find((n) => n.type === 'flowforge.formTrigger' && !n.disabled);

export interface DemoListen {
  formUrl: string;
  testUrl: string;
  expiresAt: string;
}

export async function demoListen(s: AppServices, workflowId: string): Promise<DemoListen> {
  const wf = demoWorkflow(s, workflowId);
  const trigger = formNode(wf);
  if (!trigger) throw new HttpError(400, 'The demo workflow has no Form Trigger', 'no_form_trigger');
  const res = await s.testListeners.listen(wf, trigger.name, { demo: true });
  if (res.kind !== 'webhook' || !res.testUrl) throw new HttpError(400, 'The Form Trigger could not listen', 'listen_failed');
  return { formUrl: res.testUrl, testUrl: res.testUrl, expiresAt: res.expiresAt ?? '' };
}

function sample(label: string, type: string, index: number): string {
  const l = label.toLowerCase();
  if (type === 'email' || l.includes('mail')) return 'demo@example.com';
  if (l.includes('city') || l.includes('ville')) return 'Paris';
  if (l.includes('name')) return 'Demo Visitor';
  if (type === 'number') return '42';
  if (type === 'date') return '2026-01-01';
  return `Demo answer ${index + 1}`;
}

/** Submits sample answers to the form's test URL (a real HTTP request) and returns the execution that started. */
export async function demoSimulateSubmission(s: AppServices, workflowId: string, testUrl: string | undefined, localBase: string): Promise<{ executionId: string }> {
  const wf = demoWorkflow(s, workflowId);
  const trigger = formNode(wf);
  if (!trigger) throw new HttpError(400, 'The demo workflow has no Form Trigger', 'no_form_trigger');
  let target = testUrl;
  if (!target) target = (await demoListen(s, workflowId)).testUrl;
  else if (!s.testListeners.isListening(workflowId)) target = (await demoListen(s, workflowId)).testUrl;
  const fields = ((trigger.parameters?.formFields as { values?: Array<Record<string, unknown>> } | undefined)?.values ?? []) as Array<Record<string, unknown>>;
  const body = new URLSearchParams();
  fields.forEach((f, i) => {
    const type = String(f.fieldType ?? 'text');
    if (type === 'hiddenField' || type === 'file' || type === 'html') return;
    const options = (f.fieldOptions as { values?: Array<{ option?: string }> } | undefined)?.values;
    body.set(`field-${i}`, type === 'dropdown' || type === 'radio' ? (options?.[0]?.option ?? 'Option 1') : sample(String(f.fieldLabel ?? ''), type, i));
  });
  const before = new Set(s.executionsRepo.list({ limit: 20, workflowId }).map((e) => e.id));
  const url = new URL(target);
  if (!url.pathname.startsWith('/form-test/')) throw new HttpError(400, 'Not a form test URL', 'bad_test_url');
  const res = await fetch(`${localBase}${url.pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(502, `The form did not accept the sample answers (${res.status})`, 'simulate_failed', text.slice(0, 200));
  }
  for (let i = 0; i < 40; i++) {
    const fresh = s.executionsRepo.list({ limit: 20, workflowId }).find((e) => !before.has(e.id));
    if (fresh) return { executionId: fresh.id };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new HttpError(502, 'The submission was accepted but no execution started', 'simulate_failed');
}
