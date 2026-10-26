import type { TestListenResponse, WorkflowData } from '@flowforge/shared';
import { checkNodeCredentials } from '../credentials/check.js';
import type { ExecutionService } from '../engine/execution-service.js';
import { FlowError } from '../engine/errors.js';
import { withDefaults } from '../engine/params.js';
import type { CredentialsProvider, TriggerHandle } from '../engine/types.js';
import type { Logger } from '../logger.js';
import type { NodeRegistry } from '../nodes/registry.js';
import type { WsHub } from '../ws/hub.js';
import { createTriggerContext } from './trigger-context.js';
import { normalizePath, type WebhookRegistry } from './webhook-registry.js';

export const TEST_LISTEN_MS = 120_000;
/** Forms are filled by a human (maybe on a phone): listen longer. */
export const TEST_FORM_LISTEN_MS = 300_000;

export class TestListenError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

interface Listener {
  nodeName: string;
  stop(reason: 'timeout' | 'canceled' | 'received'): void;
}

export interface TestListenersOptions {
  nodes: NodeRegistry;
  webhooks: WebhookRegistry;
  executions: ExecutionService;
  logger: Logger;
  ws?: WsHub;
  publicUrl: string;
  timezone: string;
  filesRoot: string;
  listenMs?: number;
  credentials?: CredentialsProvider;
}

/**
 * "Listen for test event": one listener per workflow, single shot, 120 s.
 * Webhooks get a /webhook-test/… URL, schedules fire now, polls fetch once, listeners wait for the next event.
 */
export class TestListeners {
  private readonly current = new Map<string, Listener>();

  constructor(private readonly o: TestListenersOptions) {}

  isListening(workflowId: string): boolean {
    return this.current.has(workflowId);
  }

  cancel(workflowId: string): boolean {
    const listener = this.current.get(workflowId);
    if (!listener) return false;
    listener.stop('canceled');
    return true;
  }

  shutdown(): void {
    for (const id of [...this.current.keys()]) this.cancel(id);
  }

  async listen(workflow: WorkflowData & { id: string }, nodeName: string, opts: { demo?: boolean } = {}): Promise<TestListenResponse> {
    this.cancel(workflow.id);
    const node = workflow.nodes.find((n) => n.name === nodeName);
    if (!node) throw new TestListenError(`Node "${nodeName}" not found`);
    if (node.disabled) throw new TestListenError(`Node "${nodeName}" is disabled`, 'Enable it first.');
    const type = this.o.nodes.require(node.type);
    const kind = type.description.trigger?.kind ?? 'manual';
    try {
      checkNodeCredentials(node, type, this.o.credentials);
    } catch (err) {
      throw new TestListenError((err as Error).message, (err as { hint?: string }).hint);
    }
    const runNow = (triggerItems?: Parameters<ExecutionService['start']>[0]['triggerItems']) =>
      this.o.executions.start({ workflow, mode: 'manual', startNode: node.name, ...(opts.demo ? { demo: true } : {}), ...(triggerItems ? { triggerItems } : {}) }).executionId;

    if (kind === 'webhook' && type.webhook) {
      const params = withDefaults(type.properties, node.parameters ?? {});
      const { methods, path: raw } = type.webhook.endpoints(node, params);
      let path: string;
      try {
        path = normalizePath(raw);
      } catch (err) {
        throw new TestListenError((err as Error).message);
      }
      const isForm = type.webhook.urlPrefix === 'form';
      const expiresAt = new Date(Date.now() + (this.o.listenMs ?? (isForm ? TEST_FORM_LISTEN_MS : TEST_LISTEN_MS)));
      const testUrl = `${this.o.publicUrl}/${type.webhook.urlPrefix}-test/${path}`;
      const reg = {
        kind: 'test' as const,
        prefix: type.webhook.urlPrefix,
        workflowId: workflow.id,
        workflow,
        nodeName: node.name,
        methods,
        path,
        onUse: () => listener.stop('received'),
        ...(opts.demo ? { demo: true } : {}),
      };
      const timer = setTimeout(() => listener.stop('timeout'), expiresAt.getTime() - Date.now());
      timer.unref();
      const listener: Listener = {
        nodeName: node.name,
        stop: (reason) => {
          clearTimeout(timer);
          this.o.webhooks.remove(reg);
          if (this.current.get(workflow.id) === listener) this.current.delete(workflow.id);
          if (reason !== 'received') this.o.ws?.broadcast('trigger.stopped', { workflowId: workflow.id, nodeName: node.name, reason });
        },
      };
      this.o.webhooks.add(reg);
      this.current.set(workflow.id, listener);
      this.o.ws?.broadcast('trigger.listening', { workflowId: workflow.id, nodeName: node.name, testUrl, method: methods.join(', '), expiresAt: expiresAt.toISOString() });
      return { kind: 'webhook', testUrl, method: methods.join(', '), expiresAt: expiresAt.toISOString() };
    }

    if (kind === 'poll' && type.poll) {
      const ctx = createTriggerContext({
        workflow,
        node,
        type,
        mode: 'manual',
        logger: this.o.logger,
        timezone: workflow.settings?.timezone || this.o.timezone,
        filesRoot: this.o.filesRoot,
        staticData: {},
        credentials: this.o.credentials,
        emit: () => undefined,
        emitError: () => undefined,
      });
      let items;
      try {
        items = await type.poll(ctx);
      } catch (err) {
        throw new TestListenError((err as Error).message);
      }
      if (!items.length) throw new TestListenError('No items found', 'The feed or URL returned no items.');
      return { kind: 'poll', executionId: runNow(items) };
    }

    if (kind === 'listener' && type.trigger) {
      const expiresAt = new Date(Date.now() + (this.o.listenMs ?? TEST_LISTEN_MS));
      let handle: TriggerHandle | undefined;
      let done = false;
      const timer = setTimeout(() => listener.stop('timeout'), expiresAt.getTime() - Date.now());
      timer.unref();
      const listener: Listener = {
        nodeName: node.name,
        stop: (reason) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          void Promise.resolve(handle?.close()).catch(() => undefined);
          if (this.current.get(workflow.id) === listener) this.current.delete(workflow.id);
          if (reason !== 'received') this.o.ws?.broadcast('trigger.stopped', { workflowId: workflow.id, nodeName: node.name, reason });
        },
      };
      const ctx = createTriggerContext({
        workflow,
        node,
        type,
        mode: 'manual',
        logger: this.o.logger,
        timezone: workflow.settings?.timezone || this.o.timezone,
        filesRoot: this.o.filesRoot,
        staticData: {},
        credentials: this.o.credentials,
        emit: (items) => {
          if (done) return;
          const executionId = runNow(items);
          this.o.ws?.broadcast('trigger.received', { workflowId: workflow.id, nodeName: node.name, executionId });
          listener.stop('received');
        },
        emitError: (err) => {
          this.o.ws?.broadcast('trigger.stopped', { workflowId: workflow.id, nodeName: node.name, reason: 'error', message: err.message });
          listener.stop('canceled');
        },
      });
      try {
        type.validate?.(ctx);
        handle = await type.trigger(ctx);
      } catch (err) {
        clearTimeout(timer);
        throw new TestListenError((err as Error).message, err instanceof FlowError ? err.hint : undefined);
      }
      this.current.set(workflow.id, listener);
      this.o.ws?.broadcast('trigger.listening', { workflowId: workflow.id, nodeName: node.name, expiresAt: expiresAt.toISOString() });
      return { kind: 'listener', expiresAt: expiresAt.toISOString() };
    }

    // Schedules fire right away; Manual / Error / Execute Workflow triggers just run (with sample data).
    return { kind: kind === 'schedule' ? 'schedule' : kind === 'event' ? 'event' : 'manual', executionId: runNow() };
  }

  /** Called by the webhook service when a test URL was used. */
  received(workflowId: string, nodeName: string, executionId: string) {
    this.o.ws?.broadcast('trigger.received', { workflowId, nodeName, executionId });
  }
}
