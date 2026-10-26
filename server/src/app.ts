import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import express, { type Express } from 'express';
import { apiRouter } from './api/index.js';
import type { AppContext } from './context.js';
import { migrateLegacyWebhookAuth } from './credentials/legacy-webhook-auth.js';
import { ExecutionService } from './engine/execution-service.js';
import { getExpressionEngine } from './engine/expressions/engine.js';
import { WorkflowRunner } from './engine/runner.js';
import { effectiveSettings } from './settings/instance-settings.js';
import { errorHandler } from './http/errors.js';
import { staticFrontend } from './http/static.js';
import { publicRouter } from './public/router.js';
import { ActiveWorkflowManager } from './triggers/active-workflows.js';
import { TestListeners } from './triggers/test-listeners.js';
import { WaitTracker } from './triggers/wait-tracker.js';
import { WebhookRegistry } from './triggers/webhook-registry.js';
import { WebhookService } from './triggers/webhook-service.js';
import { WsHub } from './ws/hub.js';

import { pruneExecutions } from './engine/pruning.js';

export interface FlowForgeApp {
  app: Express;
  server: Server;
  ws: WsHub;
  executions: ExecutionService;
  activeWorkflows: ActiveWorkflowManager;
  testListeners: TestListeners;
  waitTracker: WaitTracker;
  webhookRegistry: WebhookRegistry;
  /** Startup work: crash recovery, re-activate active workflows, resume waiting executions. */
  boot(): Promise<void>;
  close(): Promise<void>;
}

/** Services shared by the API routes. */
export interface AppServices extends AppContext {
  ws: WsHub;
  executions: ExecutionService;
  activeWorkflows: ActiveWorkflowManager;
  testListeners: TestListeners;
}

/** Builds the HTTP + WebSocket server without listening (tests call this directly). */
export function createApp(ctx: AppContext): FlowForgeApp {
  const { config, logger } = ctx;
  mkdirSync(config.filesRoot, { recursive: true });
  const ws = new WsHub(ctx);
  const liveSettings = () => effectiveSettings(ctx.settings.all(), config);
  const currentTimezone = () => liveSettings().timezone;
  const runner = new WorkflowRunner({
    registry: ctx.registry,
    expressions: getExpressionEngine(),
    binaryStore: ctx.binaryStore,
    logger,
    defaults: { timeoutMs: config.executionTimeoutMs, maxNodeRuns: config.maxNodeRuns, timezone: config.timezone },
    credentials: ctx.credentials,
    filesRoot: config.filesRoot,
    instanceSettings: ctx.settings,
    chatMemory: ctx.chatMemory,
  });
  const executions = new ExecutionService({
    repo: ctx.executionsRepo,
    workflows: ctx.workflowsRepo,
    runner,
    logger,
    binaryStore: ctx.binaryStore,
    publisher: ws,
    maxConcurrent: liveSettings().maxConcurrentExecutions,
    timeoutMs: config.executionTimeoutMs,
    timezone: config.timezone,
    allowEnvAccess: config.allowEnvAccess,
    publicUrl: config.publicUrl,
    runtime: () => {
      const all = ctx.settings.all();
      const eff = effectiveSettings(all, config);
      return {
        timezone: eff.timezone,
        timeoutMs: eff.executionTimeoutSeconds * 1000,
        allowEnvAccess: eff.allowEnvAccess,
        variables: ctx.variablesRepo.asRecord(),
        saveDataSuccess: all.saveDataSuccess,
        saveDataError: all.saveDataError,
      };
    },
  });
  const webhookRegistry = new WebhookRegistry();
  const testListeners = new TestListeners({
    nodes: ctx.registry,
    webhooks: webhookRegistry,
    executions,
    logger,
    ws,
    publicUrl: config.publicUrl,
    get timezone() {
      return currentTimezone();
    },
    filesRoot: config.filesRoot,
    credentials: ctx.credentials,
  });
  const webhooks = new WebhookService({
    registry: webhookRegistry,
    nodes: ctx.registry,
    executions,
    executionsRepo: ctx.executionsRepo,
    binaryStore: ctx.binaryStore,
    logger,
    publicUrl: config.publicUrl,
    maxBodyBytes: config.webhookMaxBodyBytes,
    formMaxBodyBytes: config.formMaxBodyBytes,
    get timezone() {
      return currentTimezone();
    },
    credentials: ctx.credentials,
    onTestReceived: (reg, executionId) => testListeners.received(reg.workflowId, reg.nodeName, executionId),
  });
  const activeWorkflows = new ActiveWorkflowManager({
    workflows: ctx.workflowsRepo,
    nodes: ctx.registry,
    executions,
    webhooks: webhookRegistry,
    logger,
    ws,
    get timezone() {
      return currentTimezone();
    },
    filesRoot: config.filesRoot,
    credentials: ctx.credentials,
  });
  const waitTracker = new WaitTracker({ repo: ctx.executionsRepo, executions, logger });
  executions.onWaiting = (id, till) => waitTracker.schedule(id, till);
  const services: AppServices = { ...ctx, ws, executions, activeWorkflows, testListeners };

  const app = express();
  app.disable('x-powered-by');
  // Trust X-Forwarded-* only from local proxies (Vite dev proxy, cloudflared).
  app.set('trust proxy', 'loopback');

  app.use('/api', apiRouter(services));
  app.use(
    publicRouter({
      webhooks,
      executions,
      executionsRepo: ctx.executionsRepo,
      nodes: ctx.registry,
      logger,
      binaryStore: ctx.binaryStore,
      ratePerMinute: config.webhookRatePerMinute,
      formRatePerMinute: config.formRatePerMinute,
      formMaxBodyBytes: config.formMaxBodyBytes,
    }),
  );
  app.use(staticFrontend(config.webDistDir));
  app.use((req, res) => {
    res.status(404).json({ error: { message: `Not found: ${req.method} ${req.path}`, code: 'not_found' } });
  });
  app.use(errorHandler(logger));

  const server = createServer(app);
  ws.attach(server);

  let pruneTimer: NodeJS.Timeout | undefined;
  const runPrune = () =>
    pruneExecutions({ repo: ctx.executionsRepo, binaryStore: ctx.binaryStore }, ctx.settings.all()).catch((err) => logger.error('Pruning executions failed', err));

  return {
    app,
    server,
    ws,
    executions,
    activeWorkflows,
    testListeners,
    waitTracker,
    webhookRegistry,
    async boot() {
      const crashed = ctx.executionsRepo.markUnfinishedAsCrashed();
      if (crashed) logger.warn(`${crashed} execution(s) were interrupted by the last shutdown and are marked as crashed`);
      try {
        migrateLegacyWebhookAuth(ctx.db, ctx.credentials, logger);
      } catch (err) {
        logger.error('Could not move old Webhook passwords to credentials', err);
      }
      await activeWorkflows.init();
      waitTracker.init();
      void runPrune();
      pruneTimer = setInterval(() => void runPrune(), 10 * 60 * 1000);
      pruneTimer.unref();
    },
    async close() {
      if (pruneTimer) clearInterval(pruneTimer);
      testListeners.shutdown();
      waitTracker.shutdown();
      await activeWorkflows.shutdown();
      executions.shutdown();
      ws.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
