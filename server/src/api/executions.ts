import { Router } from 'express';
import { z } from 'zod';
import type { ExecutionMode, ExecutionStatus, NodeRun, RunData, WorkflowData } from '@flowforge/shared';
import type { AppServices } from '../app.js';
import { badRequest, HttpError, notFound } from '../http/errors.js';
import { ACTIVE_STATUSES } from '../db/repositories/executions.js';
import { pruneExecutions } from '../engine/pruning.js';
import { WorkflowBodySchema } from './schemas.js';

const RunSchema = z.object({
  workflow: WorkflowBodySchema,
  startNode: z.string().optional(),
  destinationNode: z.string().optional(),
  previousExecutionId: z.string().optional(),
  /** Time travel "Re-run from here": this node and everything after it run again, the rest reuses `previousExecutionId`. */
  rerunFrom: z.string().optional(),
});

const STATUSES = ['queued', 'running', 'waiting', 'success', 'error', 'canceled', 'crashed'] as const;
const MODES = ['manual', 'trigger', 'webhook', 'schedule', 'form', 'chat', 'error', 'subworkflow', 'retry'] as const;
const ListSchema = z.object({
  workflowId: z.string().min(1).max(128).optional(),
  status: z.string().optional(),
  mode: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().regex(/^\d{1,15}$/, 'cursor must be an execution id').optional(),
});
const RetrySchema = z.object({ fromFailedNode: z.boolean().optional(), useCurrentWorkflow: z.boolean().optional() });
const BulkDeleteSchema = z.object({ ids: z.array(z.string().regex(/^\d{1,15}$/)).max(1000) });

function csv<T extends string>(raw: string | undefined, allowed: readonly T[], label: string): T[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map((x) => x.trim()).filter(Boolean);
  for (const part of parts) if (!(allowed as readonly string[]).includes(part)) throw badRequest(`Unknown ${label} "${part}"`, `Use one of: ${allowed.join(', ')}`);
  return parts as T[];
}

function isoDate(raw: string | undefined, label: string): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw badRequest(`"${label}" is not a valid date`, 'Use an ISO date such as 2026-01-31 or 2026-01-31T12:00:00Z');
  return new Date(t).toISOString();
}

/** The trigger that started the execution: the first node that ran without an input. */
function startedFrom(execution: { runData: RunData; events: Array<{ type: string; node: string }> }, workflow: WorkflowData): string | undefined {
  const names = new Set(workflow.nodes.map((n) => n.name));
  for (const ev of execution.events) {
    if (ev.type !== 'node.started' || !names.has(ev.node)) continue;
    const first = execution.runData[ev.node]?.[0] as NodeRun | undefined;
    if (first && (first.source ?? []).every((src) => !src)) return ev.node;
  }
  return undefined;
}

/** The node itself plus every node reachable through its connections (all types). */
function downstreamOf(workflow: WorkflowData, from: string): Set<string> {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const name = queue.shift()!;
    for (const outputs of Object.values(workflow.connections[name] ?? {})) {
      for (const targets of outputs ?? []) {
        for (const t of targets ?? []) {
          if (!seen.has(t.node)) {
            seen.add(t.node);
            queue.push(t.node);
          }
        }
      }
    }
  }
  return seen;
}

export function executionsRouter(s: AppServices): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const q = ListSchema.parse(req.query);
    res.json(
      s.executionsRepo.listPage({
        workflowId: q.workflowId,
        status: csv<ExecutionStatus>(q.status, STATUSES, 'status'),
        mode: csv<ExecutionMode>(q.mode, MODES, 'mode'),
        from: isoDate(q.from, 'from'),
        to: isoDate(q.to, 'to'),
        limit: q.limit,
        cursor: q.cursor,
      }),
    );
  });

  router.post('/prune', async (_req, res) => {
    res.json({ deleted: await pruneExecutions({ repo: s.executionsRepo, binaryStore: s.binaryStore }, s.settings.all()) });
  });

  router.post('/delete', async (req, res) => {
    const { ids } = BulkDeleteSchema.parse(req.body ?? {});
    const statuses = s.executionsRepo.statusOf(ids);
    let deleted = 0;
    for (const [id, status] of statuses) {
      if (ACTIVE_STATUSES.includes(status)) continue;
      s.executionsRepo.delete(id);
      await s.binaryStore.deleteExecution(id).catch(() => undefined);
      deleted++;
    }
    res.json({ deleted });
  });

  /** Manual run from the editor: runs the posted (possibly unsaved) workflow. Progress arrives over WebSocket. */
  router.post('/run', (req, res) => {
    const body = RunSchema.parse(req.body ?? {});
    const workflow = body.workflow as unknown as WorkflowData;
    let previousRunData: RunData | undefined;
    if (body.previousExecutionId) previousRunData = s.executionsRepo.get(body.previousExecutionId)?.runData;
    let startNode = body.startNode;
    let reuseRunData: boolean | undefined;
    if (body.rerunFrom) {
      if (!workflow.nodes.some((n) => n.name === body.rerunFrom)) throw badRequest(`Node "${body.rerunFrom}" does not exist in this workflow`);
      const previous = body.previousExecutionId ? s.executionsRepo.get(body.previousExecutionId) : undefined;
      if (!previous) throw notFound(`Execution ${body.previousExecutionId ?? '(none given)'} not found: re-run from here needs it for the earlier results`);
      const redo = downstreamOf(workflow, body.rerunFrom);
      previousRunData = {};
      for (const [name, runs] of Object.entries(previous.runData)) {
        if (!redo.has(name) && workflow.nodes.some((n) => n.name === name)) previousRunData[name] = runs;
      }
      startNode = startNode ?? startedFrom(previous, workflow);
      reuseRunData = true;
    }
    const { executionId } = s.executions.start({
      workflow,
      mode: 'manual',
      startNode,
      destinationNode: body.destinationNode,
      previousRunData,
      ...(reuseRunData ? { reuseRunData } : {}),
    });
    res.status(202).json({ executionId });
  });

  router.get('/:id', (req, res) => {
    const execution = s.executionsRepo.get(req.params.id);
    if (!execution) throw notFound(`Execution ${req.params.id} not found`);
    res.json(execution);
  });

  router.delete('/:id', async (req, res) => {
    const id = req.params.id as string;
    const status = s.executionsRepo.statusOf([id]).get(id);
    if (!status) throw notFound(`Execution ${id} not found`);
    if (ACTIVE_STATUSES.includes(status)) throw new HttpError(409, `Execution ${id} is ${status}`, 'conflict', 'Stop it first, then delete it.');
    s.executionsRepo.delete(id);
    await s.binaryStore.deleteExecution(id).catch(() => undefined);
    res.json({ deleted: 1 });
  });

  router.post('/:id/retry', (req, res) => {
    const id = req.params.id as string;
    const body = RetrySchema.parse(req.body ?? {});
    const execution = s.executionsRepo.get(id);
    if (!execution) throw notFound(`Execution ${id} not found`);
    if (!['error', 'crashed', 'canceled'].includes(execution.status)) {
      throw badRequest(`Only failed, crashed or canceled executions can be retried (this one is ${execution.status})`);
    }
    let workflow: WorkflowData = execution.workflow;
    if (body.useCurrentWorkflow) {
      const saved = execution.workflowId ? s.workflowsRepo.get(execution.workflowId) : undefined;
      if (!saved) throw notFound('The workflow of this execution no longer exists. Retry with the stored copy instead.');
      workflow = { ...saved } as unknown as WorkflowData;
    }
    // The trigger's output is always reused (a webhook / form / schedule cannot be replayed); "from failed node" also
    // reuses every node that succeeded, so only the failed node and what comes after it run again.
    const failed = execution.error?.node ?? execution.lastNodeExecuted ?? undefined;
    const startNode = startedFrom(execution, workflow);
    const previousRunData: RunData = {};
    const succeeded = (name: string) => {
      const runs = execution.runData[name];
      const last = runs?.[runs.length - 1] as NodeRun | undefined;
      return runs && last && last.status !== 'error' ? runs : undefined;
    };
    if (body.fromFailedNode !== false && failed) {
      for (const name of Object.keys(execution.runData)) {
        const runs = name !== failed && workflow.nodes.some((n) => n.name === name) ? succeeded(name) : undefined;
        if (runs) previousRunData[name] = runs;
      }
    } else if (startNode && succeeded(startNode)) {
      previousRunData[startNode] = succeeded(startNode)!;
    }
    const { executionId } = s.executions.start({
      workflow: { ...workflow, id: workflow.id ?? execution.workflowId ?? undefined },
      mode: 'retry',
      startNode,
      previousRunData,
      reuseRunData: true,
      retryOf: id,
    });
    res.status(202).json({ executionId });
  });

  router.post('/:id/stop', (req, res) => {
    if (!s.executionsRepo.get(req.params.id)) throw notFound(`Execution ${req.params.id} not found`);
    res.json({ stopped: s.executions.stop(req.params.id) });
  });

  return router;
}
