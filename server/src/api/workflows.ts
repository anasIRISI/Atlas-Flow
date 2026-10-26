import { Router } from 'express';
import { z } from 'zod';
import type { Connections, Item, WorkflowData, WorkflowNode, WorkflowSettings } from '@flowforge/shared';
import type { AppServices } from '../app.js';
import type { WorkflowInput } from '../db/repositories/workflows.js';
import { HttpError, notFound } from '../http/errors.js';
import { ActivationError } from '../triggers/active-workflows.js';
import { TestListenError } from '../triggers/test-listeners.js';
import { WorkflowBodySchema } from './schemas.js';
import { buildExport, copyName, freshWebhookIds, ImportError, importTagNames, resolveCredentialRefs, slugify, unwrapImport } from '../workflows/transfer.js';
import { badRequest } from '../http/errors.js';

const CreateSchema = z.object({ name: z.string().trim().min(1).max(128).optional() }).passthrough();
const RenameSchema = z.object({ name: z.string().trim().min(1, 'The workflow needs a name').max(128) });
const TestListenSchema = z.object({ workflow: WorkflowBodySchema, nodeName: z.string().min(1) });

function toInput(body: z.infer<typeof WorkflowBodySchema>): WorkflowInput {
  return {
    name: body.name,
    nodes: body.nodes as unknown as WorkflowNode[],
    connections: body.connections as Connections,
    settings: body.settings as WorkflowSettings,
    pinData: body.pinData as Record<string, Item[]>,
  };
}

export function workflowsRouter(s: AppServices): Router {
  const router = Router();
  const repo = s.workflowsRepo;

  router.get('/', (_req, res) => {
    res.json(repo.list());
  });

  router.post('/', (req, res) => {
    const create = CreateSchema.parse(req.body ?? {});
    const body = WorkflowBodySchema.parse({ ...req.body, name: create.name ?? repo.uniqueName('My workflow') });
    const created = repo.create(toInput(body));
    s.versionsRepo.record(created, { source: 'create' });
    res.status(201).json(created);
  });

  /** Import a workflow JSON (n8n-like, our export, or `{ workflow }`). Registered before `/:id` routes. */
  router.post('/import', (req, res) => {
    let raw: Record<string, unknown>;
    try {
      raw = unwrapImport(req.body);
    } catch (err) {
      if (err instanceof ImportError) throw badRequest(err.message);
      throw err;
    }
    const parsed = WorkflowBodySchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw badRequest(`This workflow cannot be imported: ${issue?.path.length ? issue.path.join('.') + ': ' : ''}${issue?.message ?? 'invalid'}`);
    }
    const body = parsed.data;
    const warnings: string[] = [];
    const resolved = resolveCredentialRefs(body.nodes as unknown as WorkflowNode[], s.credentials.list());
    for (const n of resolved.nodes) if (!s.registry.get(n.type)) warnings.push(`Node "${n.name}" has an unknown type (${n.type}).`);
    const created = repo.create({
      ...toInput(body),
      name: repo.uniqueName(body.name),
      nodes: freshWebhookIds(resolved.nodes),
    });
    const tagIds = importTagNames(raw).map((name) => s.tagsRepo.ensure(name).id);
    if (tagIds.length) s.tagsRepo.setForWorkflow(created.id, tagIds);
    s.versionsRepo.record(created, { source: 'import' });
    res.status(201).json({ id: created.id, name: created.name, missingCredentials: resolved.missing, warnings });
  });

  router.post('/delete', async (req, res) => {
    const { ids } = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) }).parse(req.body ?? {});
    let deleted = 0;
    for (const id of new Set(ids)) {
      if (!repo.get(id)) continue;
      await s.activeWorkflows.remove(id);
      s.testListeners.cancel(id);
      if (repo.delete(id)) deleted++;
    }
    res.json({ deleted });
  });

  router.get('/:id/export', (req, res) => {
    const wf = repo.get(req.params.id);
    if (!wf) throw notFound('Workflow not found. It may have been deleted.');
    const out = buildExport(wf, s.tagsRepo.forWorkflow(wf.id).map((t) => t.name));
    res.setHeader('Content-Disposition', `attachment; filename="${slugify(wf.name)}.json"`);
    res.json(out);
  });

  router.put('/:id/tags', (req, res) => {
    const { tagIds } = z.object({ tagIds: z.array(z.string()).max(100) }).parse(req.body ?? {});
    if (!repo.get(req.params.id)) throw notFound('Workflow not found. It may have been deleted.');
    const unique = [...new Set(tagIds)];
    const unknown = unique.filter((id) => !s.tagsRepo.get(id));
    if (unknown.length) throw badRequest(`Unknown tag id: ${unknown[0]}`);
    s.tagsRepo.setForWorkflow(req.params.id, unique);
    res.json({ tags: s.tagsRepo.forWorkflow(req.params.id) });
  });

  router.post('/:id/duplicate', (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(128).optional() }).parse(req.body ?? {});
    const src = repo.get(req.params.id);
    if (!src) throw notFound('Workflow not found. It may have been deleted.');
    const taken = repo.list().map((w) => w.name);
    let finalName = name ?? copyName(src.name, taken);
    if (name && taken.includes(name)) finalName = copyName(name, taken);
    const created = repo.create({
      name: finalName,
      nodes: freshWebhookIds(src.nodes),
      connections: src.connections,
      settings: src.settings,
      pinData: src.pinData,
    });
    s.tagsRepo.setForWorkflow(created.id, s.tagsRepo.forWorkflow(src.id).map((t) => t.id));
    s.versionsRepo.record(created, { source: 'create' });
    res.status(201).json(created);
  });

  router.get('/:id', (req, res) => {
    const wf = repo.get(req.params.id);
    if (!wf) throw notFound('Workflow not found. It may have been deleted.');
    res.json(wf);
  });

  router.put('/:id', async (req, res) => {
    const body = WorkflowBodySchema.parse(req.body ?? {});
    const wf = repo.update(req.params.id, toInput(body));
    if (!wf) throw notFound('Workflow not found. It may have been deleted.');
    // Version history: one snapshot per save that changes something (optional note from the Save dialog).
    const note = typeof (req.body as { versionNote?: unknown })?.versionNote === 'string' ? (req.body as { versionNote: string }).versionNote : null;
    s.versionsRepo.record(wf, { source: 'save', note });
    // An active workflow restarts its triggers with the saved version.
    await s.activeWorkflows.reactivateIfActive(wf.id);
    res.json(repo.get(wf.id));
  });

  router.post('/:id/activate', async (req, res) => {
    const id = req.params.id;
    if (!repo.get(id)) throw notFound('Workflow not found. It may have been deleted.');
    try {
      await s.activeWorkflows.activate(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      repo.setActive(id, false);
      repo.setActivationError(id, message);
      s.ws.broadcast('workflow.activationError', { workflowId: id, message, runtime: false });
      throw new HttpError(400, message, 'activation_failed', err instanceof ActivationError ? err.hint : undefined);
    }
    res.json(repo.get(id));
  });

  router.post('/:id/deactivate', async (req, res) => {
    const id = req.params.id;
    if (!repo.get(id)) throw notFound('Workflow not found. It may have been deleted.');
    await s.activeWorkflows.deactivate(id);
    res.json(repo.get(id));
  });

  /** "Listen for test event" on a trigger node of the (possibly unsaved) workflow in the editor. */
  router.post('/:id/test-listen', async (req, res) => {
    const id = req.params.id;
    const { workflow, nodeName } = TestListenSchema.parse(req.body ?? {});
    try {
      res.json(await s.testListeners.listen({ ...(workflow as unknown as WorkflowData), id }, nodeName));
    } catch (err) {
      if (err instanceof TestListenError) throw new HttpError(400, err.message, 'test_listen_failed', err.hint);
      throw err;
    }
  });

  router.delete('/:id/test-listen', (req, res) => {
    res.json({ stopped: s.testListeners.cancel(req.params.id) });
  });

  router.patch('/:id', (req, res) => {
    const { name } = RenameSchema.parse(req.body ?? {});
    const wf = repo.rename(req.params.id, name);
    if (!wf) throw notFound('Workflow not found. It may have been deleted.');
    res.json(wf);
  });

  router.delete('/:id', async (req, res) => {
    await s.activeWorkflows.remove(req.params.id);
    s.testListeners.cancel(req.params.id);
    if (!repo.delete(req.params.id)) throw notFound('Workflow not found. It may have been deleted.');
    res.status(204).end();
  });

  return router;
}
