import type {
  ExecutionDetail,
  ExecutionEvent,
  ExecutionMode,
  Item,
  NodeRun,
  RunData,
  ServerEvent,
  ServerEventData,
  WorkflowData,
  WsRoom,
} from '@flowforge/shared';
import { isWsRoom } from '@flowforge/shared';
import type { ExecutionsRepo } from '../db/repositories/executions.js';
import type { WorkflowsRepo } from '../db/repositories/workflows.js';
import type { Logger } from '../logger.js';
import type { BinaryStore } from './binary-store.js';
import { publicEnv } from './env.js';
import { NodeOperationError } from './errors.js';
import type { ExecutionServices } from './node-context.js';
import { ExecutionQueue } from './queue.js';
import type { EngineState, RunResult, WorkflowRunner } from './runner.js';
import type { SubWorkflowRequest, WebhookResponse } from './types.js';

export const MAX_SUBWORKFLOW_DEPTH = 10;
const ERROR_TRIGGER = 'flowforge.errorTrigger';
const SUBWORKFLOW_TRIGGER = 'flowforge.executeWorkflowTrigger';

/** Receives the HTTP response for a webhook caller (Respond to Webhook node). */
export interface WebhookResponder {
  send(response: WebhookResponse): boolean;
}

export interface StartOptions {
  workflow: WorkflowData;
  mode: ExecutionMode;
  startNode?: string;
  triggerItems?: Item[];
  destinationNode?: string;
  previousRunData?: RunData;
  responder?: WebhookResponder;
  parentExecutionId?: string;
  depth?: number;
  /** Sub-workflows run right away: their parent already holds a queue slot. */
  bypassQueue?: boolean;
  /** Id of the execution this one retries (mode "retry"). */
  retryOf?: string;
  /** Retry: reuse `previousRunData` for the nodes that have it (see RunRequest.reuseRunData). */
  reuseRunData?: boolean;
  /** Demo Mode (see RunRequest.demo). Only the demo routes set it; never taken from request bodies or workflow JSON. */
  demo?: boolean;
}

/** Values read at the start of every execution (Settings page first, then .env). Phase 7, W4. */
export interface RuntimeSettings {
  timezone: string;
  timeoutMs: number;
  allowEnvAccess: boolean;
  variables: Record<string, string>;
  /** Instance defaults when the workflow has no own "save execution data" setting. */
  saveDataSuccess: 'all' | 'none';
  saveDataError: 'all' | 'none';
}

export interface StartedExecution {
  executionId: string;
  /** Resolves when the execution has finished, was canceled, or started waiting. */
  done: Promise<ExecutionDetail>;
}

export interface EventPublisher {
  publish<T extends ServerEvent['type']>(room: WsRoom, type: T, data: ServerEventData<T>, seq?: number): void;
}

export interface ExecutionServiceOptions {
  repo: ExecutionsRepo;
  workflows?: WorkflowsRepo;
  runner: WorkflowRunner;
  logger: Logger;
  binaryStore?: BinaryStore;
  publisher?: EventPublisher;
  maxConcurrent: number;
  timeoutMs: number;
  timezone: string;
  allowEnvAccess: boolean;
  publicUrl?: string;
  /** Live settings; when missing the static values above are used. */
  runtime?: () => RuntimeSettings;
}

const PREVIEW_ITEMS = 3;
const PREVIEW_BYTES = 2048;

/** First items of the first non-empty output, small enough for a WebSocket message. */
export function previewOf(outputs: Item[][]): unknown[] {
  const items = outputs.find((list) => list.length > 0) ?? [];
  const out: unknown[] = [];
  let size = 0;
  for (const item of items.slice(0, PREVIEW_ITEMS)) {
    const length = JSON.stringify(item.json).length;
    if (size + length > PREVIEW_BYTES) {
      if (out.length === 0) out.push({ _truncated: true, fields: Object.keys(item.json).slice(0, 20) });
      break;
    }
    out.push(item.json);
    size += length;
  }
  return out;
}

interface RunContext {
  executionId: string;
  options: StartOptions;
  resume?: { state: EngineState; output: Item[]; events: ExecutionEvent[] };
}

/**
 * Creates, queues, runs and stores executions, and streams their progress over WebSocket.
 * Events go to the room `execution:<id>` and, when the workflow has an id, to `workflow:<id>`.
 */
export class ExecutionService {
  private readonly queue: ExecutionQueue;
  private readonly running = new Map<string, AbortController>();
  private readonly waiters = new Map<string, Array<(d: ExecutionDetail) => void>>();
  /** Called when an execution starts waiting (WaitTracker schedules the resume). */
  onWaiting?: (executionId: string, waitTill: Date | null) => void;

  constructor(private readonly o: ExecutionServiceOptions) {
    this.queue = new ExecutionQueue(o.maxConcurrent);
  }

  get activeCount(): number {
    return this.queue.active;
  }

  /** Settings page: change how many executions run at the same time (applies to the next ones). */
  setMaxConcurrent(n: number): void {
    this.queue.setConcurrency(n);
  }

  /** Live settings (Settings page, variables) or the static options when no provider is given. */
  private runtime(): RuntimeSettings {
    return (
      this.o.runtime?.() ?? {
        timezone: this.o.timezone,
        timeoutMs: this.o.timeoutMs,
        allowEnvAccess: this.o.allowEnvAccess,
        variables: {},
        saveDataSuccess: 'all',
        saveDataError: 'all',
      }
    );
  }

  resumeUrls(executionId: string) {
    const base = this.o.publicUrl ?? '';
    return { webhook: `${base}/webhook-waiting/${executionId}`, form: `${base}/form-waiting/${executionId}` };
  }

  start(options: StartOptions): StartedExecution {
    const { repo } = this.o;
    const executionId = repo.create({
      workflow: options.workflow,
      mode: options.mode,
      parentExecutionId: options.parentExecutionId,
      retryOf: options.retryOf,
      options: { startNode: options.startNode, destinationNode: options.destinationNode, depth: options.depth ?? 0 },
    });
    const workflowId = options.workflow.id ?? null;
    this.emit(executionId, workflowId, 'execution.queued', { executionId, workflowId, mode: options.mode });
    const done = this.enqueue({ executionId, options }, options.mode === 'manual' ? 'high' : 'normal', Boolean(options.bypassQueue));
    return { executionId, done };
  }

  /**
   * Continues a waiting execution with `output` as the result of the node that waited.
   * Returns false if the execution is not waiting (already resumed, canceled, unknown).
   */
  resume(executionId: string, output?: Item[], responder?: WebhookResponder): StartedExecution | false {
    const claimed = this.o.repo.claimWaiting(executionId);
    if (!claimed || !claimed.state) return false;
    const state = claimed.state as EngineState;
    const items = output ?? state.pendingWait?.task.inputs[0] ?? [];
    const options: StartOptions = {
      workflow: claimed.detail.workflow,
      mode: claimed.detail.mode,
      startNode: claimed.options.startNode,
      destinationNode: claimed.options.destinationNode,
      depth: claimed.options.depth,
      responder,
    };
    const done = this.enqueue({ executionId, options, resume: { state, output: items, events: claimed.detail.events } }, 'normal', false);
    return { executionId, done };
  }

  /** Resolves when the execution reaches a final state (used by sub-workflows that wait). */
  whenFinished(executionId: string): Promise<ExecutionDetail> {
    const current = this.o.repo.get(executionId);
    if (current && !['queued', 'running', 'waiting'].includes(current.status)) return Promise.resolve(current);
    return new Promise((resolve) => {
      this.waiters.set(executionId, [...(this.waiters.get(executionId) ?? []), resolve]);
    });
  }

  /** Stops a running, queued or waiting execution. Returns false if it is not active. */
  stop(executionId: string): boolean {
    const controller = this.running.get(executionId);
    if (controller) {
      controller.abort();
      return true;
    }
    if (this.queue.remove(executionId)) return true;
    const claimed = this.o.repo.claimWaiting(executionId);
    if (claimed) {
      this.finishCanceled(executionId, claimed.detail.workflow.id ?? null, 'Execution was stopped while waiting');
      return true;
    }
    return false;
  }

  /** Server shutdown: cancel everything still queued or running (waiting executions stay waiting). */
  shutdown(): void {
    this.queue.clear();
    for (const controller of this.running.values()) controller.abort();
  }

  private enqueue(run: RunContext, priority: 'high' | 'normal', bypass: boolean): Promise<ExecutionDetail> {
    return new Promise<ExecutionDetail>((resolve) => {
      const job = async () => resolve(await this.execute(run));
      if (bypass) {
        void job();
        return;
      }
      this.queue.add(
        run.executionId,
        job,
        () => resolve(this.finishCanceled(run.executionId, run.options.workflow.id ?? null, 'Execution was stopped before it started')),
        priority,
      );
    });
  }

  private finishCanceled(executionId: string, workflowId: string | null, message: string): ExecutionDetail {
    const now = new Date();
    this.o.repo.finish(executionId, {
      status: 'canceled',
      stoppedAt: now,
      lastNode: null,
      error: { name: 'ExecutionCanceledError', message },
      runData: this.o.repo.get(executionId)?.runData ?? {},
      events: this.o.repo.get(executionId)?.events ?? [],
    });
    this.emit(executionId, workflowId, 'execution.finished', {
      executionId,
      workflowId,
      status: 'canceled',
      startedAt: now.toISOString(),
      stoppedAt: now.toISOString(),
      lastNodeExecuted: null,
    });
    const detail = this.o.repo.get(executionId)!;
    this.notifyWaiters(detail);
    return detail;
  }

  private notifyWaiters(detail: ExecutionDetail) {
    if (['queued', 'running', 'waiting'].includes(detail.status)) return;
    for (const resolve of this.waiters.get(detail.id) ?? []) resolve(detail);
    this.waiters.delete(detail.id);
  }

  private emit<T extends ServerEvent['type']>(executionId: string, workflowId: string | null, type: T, data: ServerEventData<T>, seq?: number): void {
    const publisher = this.o.publisher;
    if (!publisher) return;
    publisher.publish(`execution:${executionId}`, type, data, seq);
    const room = `workflow:${workflowId ?? ''}`;
    if (workflowId && isWsRoom(room)) publisher.publish(room, type, data, seq);
  }

  private services(executionId: string, options: StartOptions): ExecutionServices {
    return {
      webhookResponder: options.responder,
      resumeUrls: this.resumeUrls(executionId),
      executeSubWorkflow: (request) => this.runSubWorkflow(executionId, (options.depth ?? 0) + 1, request),
    };
  }

  /** Runs a sub-workflow from its "Execute Workflow Trigger" and returns its last node's output. */
  private async runSubWorkflow(parentId: string, depth: number, request: SubWorkflowRequest): Promise<Item[]> {
    if (depth > MAX_SUBWORKFLOW_DEPTH) {
      throw new NodeOperationError(`Sub-workflow depth limit (${MAX_SUBWORKFLOW_DEPTH}) reached`, {
        hint: 'The workflows probably call each other in a loop.',
      });
    }
    let workflow = request.workflow;
    if (!workflow && request.workflowId) {
      const record = this.o.workflows?.get(request.workflowId);
      if (!record) throw new NodeOperationError(`Workflow "${request.workflowId}" not found`, { hint: 'It may have been deleted. Pick another workflow.' });
      workflow = this.o.workflows!.toWorkflowData(record);
    }
    if (!workflow) throw new NodeOperationError('Choose the workflow to execute');
    const trigger = workflow.nodes.find((n) => n.type === SUBWORKFLOW_TRIGGER && !n.disabled);
    if (!trigger) {
      throw new NodeOperationError(`The workflow "${workflow.name}" has no "Execute Workflow Trigger" node`, {
        hint: 'Add an "Execute Workflow Trigger" as the first node of the sub-workflow.',
      });
    }
    const started = this.start({
      workflow,
      mode: 'subworkflow',
      startNode: trigger.name,
      triggerItems: request.items.map((i) => ({ json: i.json, ...(i.binary ? { binary: i.binary } : {}) })),
      parentExecutionId: parentId,
      depth,
      bypassQueue: true,
    });
    if (!request.wait) return request.items;
    const first = await started.done;
    const detail = first.status === 'waiting' ? await this.whenFinished(started.executionId) : first;
    if (detail.status !== 'success') {
      throw new NodeOperationError(`Sub-workflow "${workflow.name}" failed: ${detail.error?.message ?? detail.status}`, {
        description: `Execution ${detail.id}${detail.error?.node ? `, node "${detail.error.node}"` : ''}`,
      });
    }
    const runs = detail.lastNodeExecuted ? detail.runData[detail.lastNodeExecuted] : undefined;
    return (runs?.[runs.length - 1]?.data.main[0] ?? []).map((i) => ({ json: i.json, ...(i.binary ? { binary: i.binary } : {}) }));
  }

  private async execute(run: RunContext): Promise<ExecutionDetail> {
    const { repo, runner, logger } = this.o;
    const { executionId, options } = run;
    const workflowId = options.workflow.id ?? null;
    const controller = new AbortController();
    this.running.set(executionId, controller);
    const startedAt = new Date();
    if (!run.resume) repo.markRunning(executionId, startedAt);
    let seq = 0;
    const events: ExecutionEvent[] = [...(run.resume?.events ?? [])];
    seq = events.length ? Math.max(...events.map((e) => e.seq)) : 0;
    const ref = { executionId, workflowId };
    this.emit(executionId, workflowId, 'execution.started', { ...ref, mode: options.mode, startedAt: startedAt.toISOString() }, ++seq);

    const settingsTimeout = options.workflow.settings?.executionTimeout;
    const rt = this.runtime();
    let result: RunResult | undefined;
    try {
      result = await runner.run({
        workflow: options.workflow,
        executionId,
        mode: options.mode,
        startNode: options.startNode,
        triggerItems: options.triggerItems,
        destinationNode: options.destinationNode,
        previousRunData: options.previousRunData,
        reuseRunData: options.reuseRunData,
        demo: options.demo === true,
        resume: run.resume ? { state: run.resume.state, output: run.resume.output } : undefined,
        signal: controller.signal,
        timeoutMs: settingsTimeout && settingsTimeout > 0 ? settingsTimeout * 1000 : rt.timeoutMs,
        timezone: options.workflow.settings?.timezone || rt.timezone,
        variables: rt.variables,
        env: rt.allowEnvAccess ? publicEnv() : null,
        services: this.services(executionId, options),
        hooks: {
          nodeStarted: (nodeName, runIndex) => {
            events.push({ seq: ++seq, ts: Date.now(), type: 'node.started', node: nodeName, runIndex });
            this.emit(executionId, workflowId, 'node.started', { ...ref, nodeName, runIndex }, seq);
          },
          nodeFinished: (nodeName, runIndex, nodeRun: NodeRun) => {
            events.push({ seq: ++seq, ts: Date.now(), type: 'node.finished', node: nodeName, runIndex, status: nodeRun.status });
            this.emit(
              executionId,
              workflowId,
              'node.finished',
              {
                ...ref,
                nodeName,
                runIndex,
                status: nodeRun.status,
                executionTime: nodeRun.executionTime,
                itemCounts: nodeRun.data.main.map((list) => list.length),
                preview: previewOf(nodeRun.data.main),
                ...(nodeRun.error ? { error: nodeRun.error } : {}),
              },
              seq,
            );
          },
          edgeData: (from, to, itemCount) => {
            this.emit(executionId, workflowId, 'edge.data', { ...ref, from, to, itemCount }, ++seq);
          },
        },
      });

      if (result.status === 'waiting' && result.wait) {
        repo.markWaiting(executionId, {
          waitTill: result.wait.till,
          node: result.wait.node,
          kind: result.wait.kind,
          state: result.wait.state,
          runData: result.runData,
          events,
        });
        this.emit(
          executionId,
          workflowId,
          'execution.waiting',
          {
            ...ref,
            nodeName: result.wait.node,
            waitTill: result.wait.till?.toISOString() ?? null,
            kind: result.wait.kind,
            resumeUrl: result.wait.kind === 'form' ? this.resumeUrls(executionId).form : this.resumeUrls(executionId).webhook,
          },
          ++seq,
        );
        logger.info(`Execution ${executionId} (${options.workflow.name}) is waiting at "${result.wait.node}"`);
        this.onWaiting?.(executionId, result.wait.till);
        return repo.get(executionId)!;
      }

      const stoppedAt = new Date();
      repo.finish(executionId, {
        status: result.status,
        stoppedAt,
        lastNode: result.lastNodeExecuted,
        error: result.error,
        runData: result.runData,
        events,
      });
      this.emit(
        executionId,
        workflowId,
        'execution.finished',
        {
          ...ref,
          status: result.status,
          startedAt: startedAt.toISOString(),
          stoppedAt: stoppedAt.toISOString(),
          lastNodeExecuted: result.lastNodeExecuted,
          ...(result.error ? { error: result.error } : {}),
        },
        ++seq,
      );
      logger.info(`Execution ${executionId} (${options.workflow.name}) finished: ${result.status}${result.error ? ` – ${result.error.message}` : ''}`);
    } catch (err) {
      // The runner never throws; this protects against bugs (e.g. a database error while saving).
      logger.error(`Execution ${executionId} crashed`, err);
      repo.finish(executionId, {
        status: 'crashed',
        stoppedAt: new Date(),
        lastNode: null,
        error: { name: 'Error', message: err instanceof Error ? err.message : String(err) },
        runData: {},
        events,
      });
    } finally {
      this.running.delete(executionId);
    }

    const detail = repo.get(executionId)!;
    this.notifyWaiters(detail);
    if (detail.status === 'error') this.startErrorWorkflow(detail, options);
    this.applySaveSettings(detail, options);
    return detail;
  }

  /** Production failures start the workflow's error workflow (its Error Trigger) with n8n's payload. */
  private startErrorWorkflow(detail: ExecutionDetail, options: StartOptions) {
    const errorWorkflowId = options.workflow.settings?.errorWorkflow;
    if (!errorWorkflowId || options.mode === 'manual' || options.mode === 'error' || !this.o.workflows) return;
    const record = this.o.workflows.get(errorWorkflowId);
    if (!record) {
      this.o.logger.warn(`Error workflow ${errorWorkflowId} of "${options.workflow.name}" does not exist`);
      return;
    }
    const workflow = this.o.workflows.toWorkflowData(record);
    const trigger = workflow.nodes.find((n) => n.type === ERROR_TRIGGER && !n.disabled);
    if (!trigger) {
      this.o.logger.warn(`Error workflow "${workflow.name}" has no Error Trigger node`);
      return;
    }
    const payload = {
      execution: {
        id: detail.id,
        url: `${this.o.publicUrl ?? ''}/executions/${detail.id}`,
        error: { message: detail.error?.message ?? 'Unknown error', name: detail.error?.name, description: detail.error?.description, node: detail.error?.node },
        lastNodeExecuted: detail.lastNodeExecuted,
        mode: detail.mode,
      },
      workflow: { id: options.workflow.id ?? null, name: options.workflow.name },
    };
    this.start({ workflow, mode: 'error', startNode: trigger.name, triggerItems: [{ json: payload }] });
  }

  /** Workflow setting "save execution data": production runs can be dropped after they finish. */
  private applySaveSettings(detail: ExecutionDetail, options: StartOptions) {
    if (options.mode === 'manual' || options.mode === 'subworkflow') return;
    const settings = options.workflow.settings ?? {};
    const rt = this.runtime();
    // The workflow's own setting wins; "default" / missing = the instance default.
    const policy = (own: string | undefined, instance: 'all' | 'none') => (own === 'all' || own === 'none' ? own : instance);
    const drop =
      (detail.status === 'success' && policy(settings.saveDataSuccessExecution, rt.saveDataSuccess) === 'none') ||
      (detail.status === 'error' && policy(settings.saveDataErrorExecution, rt.saveDataError) === 'none');
    if (!drop) return;
    this.o.repo.delete(detail.id);
    void this.o.binaryStore?.deleteExecution(detail.id);
  }
}
