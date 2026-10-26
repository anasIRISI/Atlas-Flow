import { Router } from 'express';
import { z } from 'zod';
import type { ExecutionDetail, Item, RunData, WorkflowData } from '@flowforge/shared';
import type { AppServices } from '../app.js';
import { WorkflowBodySchema } from './schemas.js';

const RequestSchema = z.object({
  workflow: WorkflowBodySchema,
  startNode: z.string().optional(),
  destinationNode: z.string().optional(),
  runData: z.record(z.string(), z.unknown()).optional(),
  triggerItems: z.array(z.unknown()).optional(),
  mode: z.enum(['manual', 'trigger']).default('manual'),
});

/** Compact result for curl: status, per-node summary and the output of the last node. */
function summarize(execution: ExecutionDetail) {
  const started = execution.startedAt ? Date.parse(execution.startedAt) : NaN;
  const stopped = execution.stoppedAt ? Date.parse(execution.stoppedAt) : NaN;
  const nodes = execution.events
    .filter((e) => e.type === 'node.finished')
    .map((e) => {
      const run = execution.runData[e.node]?.[e.runIndex];
      return {
        node: e.node,
        run: e.runIndex,
        status: e.status,
        items: run?.data.main.map((list) => list.length) ?? [],
        ...(run?.error ? { error: run.error.message } : {}),
        ...(run?.logs?.length ? { logs: run.logs } : {}),
      };
    });
  const last = execution.lastNodeExecuted ? execution.runData[execution.lastNodeExecuted] : undefined;
  return {
    executionId: execution.id,
    status: execution.status,
    durationMs: Number.isNaN(started) || Number.isNaN(stopped) ? null : stopped - started,
    lastNodeExecuted: execution.lastNodeExecuted,
    error: execution.error,
    nodes,
    output: last?.[last.length - 1]?.data.main.map((list) => list.map((item) => item.json)) ?? [],
  };
}

/**
 * Development helper: run a workflow JSON without the editor.
 * Body = a workflow JSON, or { workflow, startNode?, destinationNode?, runData?, triggerItems?, mode? }.
 * Query: ?wait=false returns the execution id immediately.
 */
export function devRouter(s: AppServices): Router {
  const router = Router();

  router.post('/run', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parsed = RequestSchema.parse('nodes' in body ? { workflow: body } : body);
    const query = req.query as Record<string, string | undefined>;
    const started = s.executions.start({
      workflow: parsed.workflow as unknown as WorkflowData,
      mode: (query.mode as 'manual' | 'trigger' | undefined) ?? parsed.mode,
      startNode: query.startNode ?? parsed.startNode,
      destinationNode: query.destinationNode ?? parsed.destinationNode,
      previousRunData: parsed.runData as RunData | undefined,
      triggerItems: parsed.triggerItems?.map((i) => (typeof i === 'object' && i !== null && 'json' in i ? (i as Item) : ({ json: i } as Item))),
    });
    if (query.wait === 'false') {
      res.status(202).json({ executionId: started.executionId });
      return;
    }
    res.json(summarize(await started.done));
  });

  return router;
}
