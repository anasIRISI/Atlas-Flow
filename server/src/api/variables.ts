import { Router } from 'express';
import { z } from 'zod';
import type { AppServices } from '../app.js';
import { conflict, notFound } from '../http/errors.js';

const Key = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/, 'Use letters, digits and _ (max 64), starting with a letter or _');
const Value = z.string().max(10_000);
const CreateSchema = z.strictObject({ key: Key, value: Value });
const PatchSchema = z.strictObject({ key: Key.optional(), value: Value.optional() });

/** /api/variables — owner: W4. Contract: docs/phase7-contracts.md */
export function variablesRouter(s: AppServices): Router {
  const router = Router({ mergeParams: true });
  const repo = s.variablesRepo;
  const taken = (key: string) => conflict(`A variable named "${key}" already exists`, 'Pick another key or edit the existing variable.');

  router.get('/', (_req, res) => {
    res.json(repo.list());
  });

  router.post('/', (req, res) => {
    const body = CreateSchema.parse(req.body ?? {});
    if (repo.findByKey(body.key)) throw taken(body.key);
    res.status(201).json(repo.create(body.key, body.value));
  });

  router.patch('/:id', (req, res) => {
    const id = String(req.params.id);
    const body = PatchSchema.parse(req.body ?? {});
    if (!repo.get(id)) throw notFound('Variable not found');
    if (body.key) {
      const other = repo.findByKey(body.key);
      if (other && other.id !== id) throw taken(body.key);
    }
    res.json(repo.update(id, body));
  });

  router.delete('/:id', (req, res) => {
    if (!repo.delete(String(req.params.id))) throw notFound('Variable not found');
    res.status(204).end();
  });

  return router;
}
