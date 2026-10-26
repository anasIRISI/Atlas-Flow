import { Router } from 'express';
import { z } from 'zod';
import type { Item, RunData, TaskSource, WorkflowData } from '@flowforge/shared';
import type { AppServices } from '../app.js';
import { publicEnv } from '../engine/env.js';
import { serializeError } from '../engine/errors.js';
import { effectiveSettings } from '../settings/instance-settings.js';
import { getExpressionEngine } from '../engine/expressions/engine.js';

const PreviewSchema = z.object({
  expression: z.string().max(20_000),
  workflow: z.record(z.string(), z.unknown()).optional(),
  runData: z.record(z.string(), z.unknown()).optional(),
  nodeName: z.string().optional(),
  /** Input items of the node (plain objects are accepted and wrapped as { json }). */
  inputItems: z.array(z.unknown()).optional(),
  source: z.array(z.unknown()).optional(),
  itemIndex: z.number().int().min(0).default(0),
  runIndex: z.number().int().min(0).default(0),
});

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function expressionsRouter(s: AppServices): Router {
  const router = Router();

  /** Evaluates an expression for the editor's live preview. Always 200: errors are part of the result. */
  router.post('/preview', (req, res) => {
    const body = PreviewSchema.parse(req.body ?? {});
    const workflow = (body.workflow as WorkflowData | undefined) ?? { name: 'Preview', nodes: [], connections: {} };
    const items = (body.inputItems ?? []).map((i) =>
      typeof i === 'object' && i !== null && 'json' in i ? (i as Item) : ({ json: (i ?? {}) as Item['json'] } as Item),
    );
    try {
      const value = getExpressionEngine().evaluate(
        body.expression,
        {
          workflow: { ...workflow, nodes: workflow.nodes ?? [], connections: workflow.connections ?? {} },
          runData: (body.runData as RunData | undefined) ?? {},
          nodeName: body.nodeName ?? '',
          inputs: [items],
          sources: (body.source as (TaskSource | null)[] | undefined) ?? [],
          runIndex: body.runIndex,
          mode: 'manual',
          executionId: 'preview',
          timezone: workflow.settings?.timezone || effectiveSettings(s.settings.all(), s.config).timezone,
          variables: s.variablesRepo.asRecord(),
          env: effectiveSettings(s.settings.all(), s.config).allowEnvAccess ? publicEnv() : null,
        },
        body.itemIndex,
      );
      res.json({ ok: true, value: value ?? null, type: typeOf(value) });
    } catch (err) {
      res.json({ ok: false, error: serializeError(err) });
    }
  });

  return router;
}
