import { Router } from 'express';
import { z } from 'zod';
import type { WorkflowNode } from '@flowforge/shared';
import type { AppServices } from '../app.js';

const OutputsSchema = z.object({
  node: z.object({
    name: z.string().default('node'),
    type: z.string(),
    parameters: z.record(z.string(), z.unknown()).default({}),
    onError: z.enum(['stopWorkflow', 'continueRegularOutput', 'continueErrorOutput']).optional(),
  }),
});

export function nodeTypesRouter(s: AppServices): Router {
  const router = Router();

  /** Every node type with its parameter schema: the editor builds its forms from this. */
  router.get('/', (_req, res) => {
    res.json(s.registry.list());
  });

  /** Outputs of a node for the given parameters (Switch, Filter… have dynamic outputs). */
  router.post('/outputs', (req, res) => {
    const { node } = OutputsSchema.parse(req.body ?? {});
    res.json(s.registry.outputsFor({ id: 'x', typeVersion: 1, position: [0, 0], ...node } as WorkflowNode));
  });

  return router;
}
