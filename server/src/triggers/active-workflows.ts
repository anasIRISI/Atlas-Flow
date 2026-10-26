import type { Item, WorkflowData, WorkflowNode } from '@flowforge/shared';
import { checkNodeCredentials } from '../credentials/check.js';
import type { WorkflowsRepo } from '../db/repositories/workflows.js';
import type { ExecutionService } from '../engine/execution-service.js';
import { FlowError } from '../engine/errors.js';
import { withDefaults } from '../engine/params.js';
import type { CredentialsProvider, NodeType, TriggerContext } from '../engine/types.js';
import type { Logger } from '../logger.js';
import type { NodeRegistry } from '../nodes/registry.js';
import type { WsHub } from '../ws/hub.js';
import { pollIntervalMs } from './dedupe.js';
import { createTriggerContext } from './trigger-context.js';
import { normalizePath, WebhookPathError, type WebhookRegistry } from './webhook-registry.js';

export class ActivationError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

type Closer = () => Promise<void> | void;

interface ActiveEntry {
  workflow: WorkflowData;
  closers: Closer[];
  staticData: Record<string, Record<string, unknown>>;
}

const ACTIVATABLE = new Set(['webhook', 'schedule', 'poll', 'listener']);

export interface ActiveWorkflowOptions {
  workflows: WorkflowsRepo;
  nodes: NodeRegistry;
  executions: ExecutionService;
  webhooks: WebhookRegistry;
  logger: Logger;
  ws?: WsHub;
  timezone: string;
  filesRoot: string;
  credentials?: CredentialsProvider;
}

/** Starts repeating polls; the first poll runs right away (it records what already exists). */
function startPolling(ctx: TriggerContext, type: NodeType, intervalMs: number, afterPoll: () => void): Closer {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const items = await type.poll!(ctx);
      if (!stopped && items.length) ctx.emit(items);
      afterPoll();
    } catch (err) {
      if (!stopped) ctx.emitError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void tick(), intervalMs);
        timer.unref?.();
      }
    }
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Keeps the triggers of active workflows running: webhooks, schedules, polls and listeners.
 * Activation validates everything first, then starts; activating twice never creates duplicates.
 */
export class ActiveWorkflowManager {
  private readonly active = new Map<string, ActiveEntry>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly o: ActiveWorkflowOptions) {}

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  /** Number of running trigger handles (tests use it to check that nothing leaks). */
  get listenerCount(): number {
    return [...this.active.values()].reduce((n, e) => n + e.closers.length, 0);
  }

  getWorkflow(id: string): WorkflowData | undefined {
    return this.active.get(id)?.workflow;
  }

  /** On boot: re-activate every workflow marked active. Failures deactivate it and record the reason. */
  async init(): Promise<void> {
    for (const id of this.o.workflows.listActiveIds()) {
      try {
        await this.activate(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.o.workflows.setActive(id, false);
        this.o.workflows.setActivationError(id, message);
        this.o.logger.warn(`Could not re-activate workflow ${id}: ${message}`);
      }
    }
  }

  activate(id: string): Promise<void> {
    return this.lock(id, () => this.doActivate(id));
  }

  deactivate(id: string): Promise<void> {
    return this.lock(id, async () => {
      await this.stop(id);
      this.o.workflows.setActive(id, false);
      this.o.ws?.broadcast('workflow.deactivated', { workflowId: id });
    });
  }

  /** Workflow saved: an active workflow restarts with the new version (or is deactivated if that fails). */
  async reactivateIfActive(id: string): Promise<string | null> {
    if (!this.active.has(id) && !this.o.workflows.listActiveIds().includes(id)) return null;
    try {
      await this.activate(id);
      return null;
    } catch (err) {
      await this.lock(id, () => this.stop(id));
      const message = err instanceof Error ? err.message : String(err);
      this.o.workflows.setActive(id, false);
      this.o.workflows.setActivationError(id, message);
      this.o.ws?.broadcast('workflow.activationError', { workflowId: id, message, runtime: false });
      return message;
    }
  }

  /** Workflow deleted: stop everything (no DB update, the row is gone). */
  async remove(id: string): Promise<void> {
    await this.lock(id, () => this.stop(id));
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.active.keys()]) await this.stop(id);
  }

  private async lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }

  private async stop(id: string): Promise<void> {
    const entry = this.active.get(id);
    this.active.delete(id);
    this.o.webhooks.removeWorkflow('prod', id);
    if (!entry) return;
    for (const close of entry.closers) {
      try {
        await close();
      } catch (err) {
        this.o.logger.warn(`Error while stopping a trigger of workflow ${id}`, err);
      }
    }
    this.o.workflows.setStaticData(id, entry.staticData);
  }

  private reportError(id: string, node: string, err: Error) {
    const message = `${node}: ${err.message}`;
    this.o.workflows.setTriggerError(id, message);
    this.o.logger.warn(`Trigger error in workflow ${id} – ${message}`);
    this.o.ws?.broadcast('workflow.activationError', { workflowId: id, message, runtime: true });
  }

  private clearError(id: string) {
    const record = this.o.workflows.get(id);
    if (record?.triggerError) this.o.workflows.setTriggerError(id, null);
  }

  private async doActivate(id: string): Promise<void> {
    const record = this.o.workflows.get(id);
    if (!record) throw new ActivationError('Workflow not found');
    const workflow = this.o.workflows.toWorkflowData(record);
    await this.stop(id);

    const triggers: Array<{ node: WorkflowNode; type: NodeType; kind: string }> = [];
    for (const node of workflow.nodes) {
      if (node.disabled) continue;
      const type = this.o.nodes.get(node.type);
      if (!type) throw new ActivationError(`Unknown node type "${node.type}" in node "${node.name}"`);
      const kind = type.description.trigger?.kind;
      if (kind && ACTIVATABLE.has(kind)) triggers.push({ node, type, kind });
    }
    if (triggers.length === 0) {
      throw new ActivationError('This workflow has no trigger that can be activated', 'Manual, Error and Execute Workflow triggers run on demand. Add a Webhook, Schedule or polling trigger.');
    }

    const entry: ActiveEntry = { workflow, closers: [], staticData: this.o.workflows.getStaticData(id) };
    const contextFor = (node: WorkflowNode, type: NodeType, mode: 'trigger') =>
      createTriggerContext({
        workflow,
        node,
        type,
        mode,
        logger: this.o.logger,
        timezone: workflow.settings?.timezone || this.o.timezone,
        filesRoot: this.o.filesRoot,
        staticData: entry.staticData,
        emit: (items: Item[]) => {
          this.clearError(id);
          this.o.executions.start({ workflow, mode: type.description.trigger?.kind === 'schedule' ? 'schedule' : 'trigger', startNode: node.name, triggerItems: items });
        },
        emitError: (err) => this.reportError(id, node.name, err),
        credentials: this.o.credentials,
        saveStaticData: () => this.o.workflows.setStaticData(id, entry.staticData),
      });

    // 1. Validate everything (nothing is started if one trigger is misconfigured).
    const starters: Array<() => Promise<Closer>> = [];
    for (const { node, type, kind } of triggers) {
      const ctx = contextFor(node, type, 'trigger');
      try {
        checkNodeCredentials(node, type, this.o.credentials);
        if (kind === 'webhook') {
          const spec = type.webhook!;
          const params = withDefaults(type.properties, node.parameters ?? {});
          const { methods, path: rawPath } = spec.endpoints(node, params);
          const path = normalizePath(rawPath);
          const conflict = this.o.webhooks.findConflict(methods, path, id, node.name, spec.urlPrefix);
          if (conflict) {
            const what = spec.urlPrefix;
            throw new ActivationError(`The ${what} path "${path}" (${methods.join(', ')}) is already used by the active workflow "${conflict.workflow.name}"`, 'Change the path or the HTTP method.');
          }
          starters.push(async () => {
            const reg = { kind: 'prod' as const, prefix: spec.urlPrefix, workflowId: id, workflow, nodeName: node.name, methods, path };
            this.o.webhooks.add(reg);
            return () => this.o.webhooks.remove(reg);
          });
        } else {
          type.validate?.(ctx);
          if (kind === 'poll') {
            if (!type.poll) throw new ActivationError(`Node "${node.name}" cannot poll`);
            const interval = pollIntervalMs(ctx.getNodeParameter('pollInterval'), ctx.getNodeParameter('pollUnit'));
            starters.push(async () => startPolling(ctx, type, interval, () => this.o.workflows.setStaticData(id, entry.staticData)));
          } else {
            if (!type.trigger) throw new ActivationError(`Node "${node.name}" cannot be activated`);
            starters.push(async () => {
              const handle = await type.trigger!(ctx);
              return () => handle.close();
            });
          }
        }
      } catch (err) {
        if (err instanceof ActivationError) throw new ActivationError(`${node.name}: ${err.message}`, err.hint);
        if (err instanceof WebhookPathError) throw new ActivationError(`${node.name}: ${err.message}`, 'Use letters, numbers, "-", "_", "." and ":param" segments.');
        const hint = err instanceof FlowError ? err.hint : undefined;
        throw new ActivationError(`${node.name}: ${err instanceof Error ? err.message : String(err)}`, hint);
      }
    }

    // 2. Start; if anything fails, undo what was started.
    try {
      for (const start of starters) entry.closers.push(await start());
    } catch (err) {
      for (const close of entry.closers) await Promise.resolve(close()).catch(() => undefined);
      this.o.webhooks.removeWorkflow('prod', id);
      throw new ActivationError(err instanceof Error ? err.message : String(err), err instanceof FlowError ? err.hint : undefined);
    }
    this.active.set(id, entry);
    this.o.workflows.setActive(id, true);
    this.o.ws?.broadcast('workflow.activated', { workflowId: id });
    this.o.logger.info(`Workflow "${workflow.name}" is active (${triggers.length} trigger${triggers.length === 1 ? '' : 's'})`);
  }
}
