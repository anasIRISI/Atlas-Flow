import { Router } from 'express';
import { z } from 'zod';
import type { AppServices } from '../app.js';
import { buildWorkflow } from '../ai/builder/index.js';
import { EXAMPLES_DIR } from './examples.js';

const BuildBody = z.object({
  prompt: z.string({ error: 'prompt is required' }).trim().min(3, 'Describe the workflow in at least 3 characters').max(2000, 'The description is too long (2000 characters max)'),
});

/** AI features: POST /api/ai/build-workflow (AI Workflow Builder). */
export function aiRouter(s: AppServices): Router {
  const router = Router();

  router.post('/build-workflow', async (req, res) => {
    const { prompt } = BuildBody.parse(req.body ?? {});
    // Stop waiting for Gemini when the browser goes away.
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const result = await buildWorkflow(prompt, { registry: s.registry, credentials: s.credentials, examplesDir: EXAMPLES_DIR, logger: s.logger, signal: abort.signal });
    res.json(result);
  });

  return router;
}
