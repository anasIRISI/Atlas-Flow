import { Router } from 'express';
import { z } from 'zod';
import type { AppServices } from '../app.js';
import { conflict, notFound } from '../http/errors.js';

const NameSchema = z.object({ name: z.string().trim().min(1, 'The tag needs a name').max(32, 'A tag name has at most 32 characters') });

/** /api/tags — owner: W1. Contract: docs/phase7-contracts.md */
export function tagsRouter(s: AppServices): Router {
  const router = Router({ mergeParams: true });
  const repo = s.tagsRepo;

  router.get('/', (_req, res) => {
    res.json(repo.list());
  });

  router.post('/', (req, res) => {
    const { name } = NameSchema.parse(req.body ?? {});
    if (repo.findByName(name)) throw conflict(`A tag named "${name}" already exists.`);
    res.status(201).json(repo.create(name));
  });

  router.patch('/:id', (req, res) => {
    const { name } = NameSchema.parse(req.body ?? {});
    if (!repo.get(req.params.id)) throw notFound('Tag not found.');
    const same = repo.findByName(name);
    if (same && same.id !== req.params.id) throw conflict(`A tag named "${name}" already exists.`);
    res.json(repo.rename(req.params.id, name));
  });

  router.delete('/:id', (req, res) => {
    if (!repo.delete(req.params.id)) throw notFound('Tag not found.');
    res.status(204).end();
  });

  return router;
}
