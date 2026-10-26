import { Router } from 'express';
import { z } from 'zod';
import type { AppServices } from '../app.js';
import { HttpError, notFound } from '../http/errors.js';

const NoteSchema = z.object({ note: z.string().trim().max(200, 'The note can have at most 200 characters').nullish() });

/** /api/workflows/:id/versions — contract: docs/phase7-contracts.md */
export function versionsRouter(s: AppServices): Router {
  const router = Router({ mergeParams: true });
  const wfId = (req: { params: Record<string, string | string[] | undefined> }) => String(req.params.id);
  const workflow = (req: { params: Record<string, string | string[] | undefined> }) => {
    const wf = s.workflowsRepo.get(wfId(req));
    if (!wf) throw notFound('Workflow not found. It may have been deleted.');
    return wf;
  };
  const numberOf = (req: { params: Record<string, string | string[] | undefined> }) => {
    const raw = String(req.params.number);
    if (!/^[1-9]\d{0,9}$/.test(raw)) throw new HttpError(400, 'The version number must be a positive integer.', 'bad_version');
    return Number(raw);
  };

  router.get('/', (req, res) => {
    workflow(req);
    res.json(s.versionsRepo.list(wfId(req)));
  });

  router.get('/:number', (req, res) => {
    workflow(req);
    const v = s.versionsRepo.get(wfId(req), numberOf(req));
    if (!v) throw notFound('This version does not exist (it may have been removed from the history).');
    res.json(v);
  });

  router.patch('/:number', (req, res) => {
    workflow(req);
    const { note } = NoteSchema.parse(req.body ?? {});
    const n = numberOf(req);
    if (!s.versionsRepo.setNote(wfId(req), n, note || null)) throw notFound('This version does not exist.');
    res.json(s.versionsRepo.get(wfId(req), n));
  });

  router.post('/:number/restore', async (req, res) => {
    const wf = workflow(req);
    const { note } = NoteSchema.parse(req.body ?? {});
    const n = numberOf(req);
    const v = s.versionsRepo.get(wf.id, n);
    if (!v) throw notFound('This version does not exist (it may have been removed from the history).');
    const updated = s.workflowsRepo.update(wf.id, { name: v.name, nodes: v.nodes, connections: v.connections, settings: v.settings, pinData: wf.pinData });
    if (!updated) throw notFound('Workflow not found. It may have been deleted.');
    s.versionsRepo.record(updated, { source: 'restore', note: note || `Restored from version ${n}`, restoredFrom: n });
    await s.activeWorkflows.reactivateIfActive(updated.id);
    res.json(s.workflowsRepo.get(updated.id));
  });

  return router;
}
