import { Router } from 'express';
import { z } from 'zod';
import type { AppServices } from '../app.js';
import { TestListenError } from '../triggers/test-listeners.js';
import { HttpError } from '../http/errors.js';
import { buildDemo, demoListen, demoSimulateSubmission } from '../demo/service.js';

const Build = z.object({ prompt: z.string().trim().max(2000).optional(), showcase: z.boolean().optional() });
const Target = z.object({ workflowId: z.string().min(1), testUrl: z.string().max(2000).optional() });

/** /api/demo/* — Demo Mode (the only place that can start executions with `demo: true`). Contract: docs/phase8-contracts.md */
export function demoRouter(s: AppServices): Router {
  const router = Router();

  router.post('/build', async (req, res) => {
    const { prompt, showcase } = Build.parse(req.body ?? {});
    res.json(await buildDemo(s, prompt, showcase === true));
  });

  router.post('/listen', async (req, res) => {
    const { workflowId } = Target.parse(req.body ?? {});
    try {
      res.json(await demoListen(s, workflowId));
    } catch (err) {
      if (err instanceof TestListenError) throw new HttpError(400, err.message, 'test_listen_failed', err.hint);
      throw err;
    }
  });

  router.post('/simulate-submission', async (req, res) => {
    const { workflowId, testUrl } = Target.parse(req.body ?? {});
    try {
      res.json(await demoSimulateSubmission(s, workflowId, testUrl, `http://127.0.0.1:${req.socket.localPort ?? s.config.port}`));
    } catch (err) {
      if (err instanceof TestListenError) throw new HttpError(400, err.message, 'test_listen_failed', err.hint);
      throw err;
    }
  });

  return router;
}
