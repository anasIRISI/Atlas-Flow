// Template library: examples/*.json + templates/*.json + the built-in templates of the AI builder.
// Contract: docs/phase7-contracts.md (W5)
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connections, TemplateCategory, TemplateDetail, WorkflowNode, WorkflowRecord, WorkflowSettings } from '@flowforge/shared';
import { WorkflowBodySchema } from '../api/schemas.js';
import type { AppServices } from '../app.js';
import { buildCatalog } from '../ai/builder/catalog.js';
import { layoutNodes } from '../ai/builder/layout.js';
import { BUILT_IN_TEMPLATES } from '../ai/builder/templates.js';
import { validateWorkflow } from '../ai/builder/validate.js';
import type { NodeRegistry } from '../nodes/registry.js';
import { ROOT_DIR } from '../paths.js';

export const EXAMPLES_DIR = join(ROOT_DIR, 'examples');
export const TEMPLATES_DIR = join(ROOT_DIR, 'templates');

export const TEMPLATE_CATEGORIES: TemplateCategory[] = ['AI', 'Forms', 'Email', 'Messaging', 'Data', 'Scheduling', 'Webhooks', 'Utilities'];

/** One workflow of a multi-workflow file. `key` is what other workflows refer to as `ref:<key>`. */
export interface BundleWorkflow {
  key?: string;
  name?: string;
  nodes?: WorkflowNode[];
  connections?: Connections;
  settings?: WorkflowSettings;
}

export interface TemplateFile extends BundleWorkflow {
  /** Multi-workflow file: the first one is the main workflow (opened after the import). */
  workflows?: BundleWorkflow[];
  meta?: { description?: string; categories?: string[] };
}

/** Prefix of a reference to another workflow of the same file (settings.errorWorkflow, Execute Workflow workflowId). */
export const REF_PREFIX = 'ref:';

const STICKY = 'flowforge.stickyNote';

/** Categories from the node types of a template. */
export function deriveCategories(types: string[]): TemplateCategory[] {
  const has = (...names: string[]) => types.some((t) => names.includes(t.replace('flowforge.', '')));
  const out = new Set<TemplateCategory>();
  if (has('googleGemini', 'aiAgent', 'geminiChatModel', 'chatTrigger')) out.add('AI');
  if (has('formTrigger')) out.add('Forms');
  if (has('sendEmail')) out.add('Email');
  if (has('telegram', 'telegramTrigger', 'discord')) out.add('Messaging');
  if (has('scheduleTrigger')) out.add('Scheduling');
  if (has('webhook', 'respondToWebhook')) out.add('Webhooks');
  if (has('httpRequest', 'graphql', 'set', 'code', 'filter', 'sort', 'limit', 'summarize', 'aggregate', 'splitOut', 'removeDuplicates', 'dateTime', 'openMeteo')) out.add('Data');
  if (out.size === 0) out.add('Utilities');
  return [...out];
}

function toDetail(id: string, source: 'example' | 'template', file: TemplateFile, registry: NodeRegistry): TemplateDetail | undefined {
  const bundle = Array.isArray(file.workflows) ? file.workflows.filter((w) => Array.isArray(w.nodes) && w.nodes.length > 0) : [];
  const main = bundle[0] ?? file;
  if (!Array.isArray(main.nodes) || main.nodes.length === 0) return undefined;
  const allNodes = bundle.length ? bundle.flatMap((w) => w.nodes ?? []) : main.nodes;
  const real = allNodes.filter((n) => n.type !== STICKY);
  const nodeTypes = [...new Set(real.map((n) => n.type))];
  const credentialTypes = new Set<string>();
  for (const t of nodeTypes) for (const c of registry.get(t)?.description.credentials ?? []) if (c.required) credentialTypes.add(c.type);
  const wanted = (file.meta?.categories ?? []).filter((c): c is TemplateCategory => (TEMPLATE_CATEGORIES as string[]).includes(c));
  return {
    id: `${source}:${id}`,
    name: file.name ?? main.name ?? id,
    description: file.meta?.description ?? '',
    categories: wanted.length ? wanted : deriveCategories(nodeTypes),
    nodeCount: real.length,
    nodeTypes,
    credentialTypes: [...credentialTypes],
    source,
    nodes: main.nodes,
    connections: main.connections ?? {},
  };
}

function readDir(dir: string, source: 'example' | 'template', registry: NodeRegistry): TemplateDetail[] {
  if (!existsSync(dir)) return [];
  const out: TemplateDetail[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    try {
      const detail = toDetail(f.slice(0, -5), source, JSON.parse(readFileSync(join(dir, f), 'utf8')) as TemplateFile, registry);
      if (detail) out.push(detail);
    } catch {
      // a broken file must never break the gallery
    }
  }
  return out;
}

function builtIns(registry: NodeRegistry): TemplateDetail[] {
  const catalog = buildCatalog(registry);
  const out: TemplateDetail[] = [];
  for (const t of BUILT_IN_TEMPLATES) {
    const result = validateWorkflow(t.workflow, { registry, catalog });
    if (!result.workflow) continue;
    const { nodes, connections } = result.workflow;
    layoutNodes(nodes, connections);
    const detail = toDetail(t.id, 'template', { name: t.name, nodes, connections, meta: { description: t.description } }, registry);
    if (detail) out.push(detail);
  }
  return out;
}

/** Every template (examples first, then templates/, then the built-in ones). */
export function loadAllTemplates(registry: NodeRegistry, dirs: { examples?: string; templates?: string } = {}): TemplateDetail[] {
  return [...readDir(dirs.examples ?? EXAMPLES_DIR, 'example', registry), ...readDir(dirs.templates ?? TEMPLATES_DIR, 'template', registry), ...builtIns(registry)];
}

export function matchesQuery(t: { name: string; description: string; nodeTypes: string[] }, q: string): boolean {
  const hay = `${t.name} ${t.description} ${t.nodeTypes.map((x) => x.replace('flowforge.', '')).join(' ')}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function importOne(s: AppServices, file: BundleWorkflow): WorkflowRecord {
  const body = WorkflowBodySchema.parse({ name: file.name, nodes: file.nodes, connections: file.connections, settings: file.settings });
  const nodes = (body.nodes as unknown as WorkflowNode[]).map((n) => (n.webhookId ? { ...n, webhookId: randomUUID() } : n));
  const wf = s.workflowsRepo.create({
    name: s.workflowsRepo.uniqueName(body.name),
    nodes,
    connections: body.connections as Connections,
    settings: body.settings as WorkflowSettings,
    pinData: {},
  });
  s.versionsRepo.record(wf, { source: 'import' });
  return wf;
}

/** Validates a workflow file, gives it a unique name and fresh webhook ids, stores it and records the version. */
export function importWorkflowFile(s: AppServices, file: { name?: string; nodes?: unknown; connections?: unknown; settings?: unknown }): WorkflowRecord {
  return importOne(s, file as BundleWorkflow);
}

/**
 * Imports a file with `workflows: [...]` together: every workflow is stored, then the references `ref:<key>` in
 * `settings.errorWorkflow` and in the `workflowId` of Execute Workflow nodes are replaced by the new ids.
 * Returns the records in file order (the first is the main workflow). A single-workflow file returns one record.
 */
export function importWorkflowBundle(s: AppServices, file: TemplateFile): WorkflowRecord[] {
  if (!Array.isArray(file.workflows) || file.workflows.length === 0) return [importOne(s, { ...file, name: file.name })];
  const created = file.workflows.map((w, i) => ({ key: w.key ?? String(i), record: importOne(s, { ...w, name: w.name ?? file.name }) }));
  const ids = new Map(created.map((c) => [c.key, c.record.id]));
  const swap = (value: unknown): unknown => {
    if (typeof value !== 'string' || !value.startsWith(REF_PREFIX)) return value;
    return ids.get(value.slice(REF_PREFIX.length)) ?? value;
  };
  return created.map(({ record }) => {
    const nodes = record.nodes.map((n) => (n.type === 'flowforge.executeWorkflow' && 'workflowId' in n.parameters ? { ...n, parameters: { ...n.parameters, workflowId: swap(n.parameters.workflowId) as string } } : n));
    const settings = { ...record.settings };
    if (settings.errorWorkflow) settings.errorWorkflow = swap(settings.errorWorkflow) as string;
    const changed = JSON.stringify(nodes) !== JSON.stringify(record.nodes) || settings.errorWorkflow !== record.settings?.errorWorkflow;
    if (!changed) return record;
    const updated = s.workflowsRepo.update(record.id, { name: record.name, nodes, connections: record.connections, settings, pinData: {} })!;
    s.versionsRepo.record(updated, { source: 'import' });
    return updated;
  });
}

/** Imports what a gallery entry stands for: an example file may hold several workflows. */
export function importTemplate(s: AppServices, t: TemplateDetail, dirs: { examples?: string } = {}): WorkflowRecord {
  if (t.source === 'example' && /^[\w-]+$/.test(t.id.slice('example:'.length))) {
    const file = join(dirs.examples ?? EXAMPLES_DIR, `${t.id.slice('example:'.length)}.json`);
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8')) as TemplateFile;
      if (Array.isArray(data.workflows) && data.workflows.length) return importWorkflowBundle(s, data)[0]!;
    }
  }
  return importWorkflowFile(s, { name: t.name, nodes: t.nodes, connections: t.connections });
}
