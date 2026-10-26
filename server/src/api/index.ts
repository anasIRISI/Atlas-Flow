import express, { Router } from 'express';
import { APP_NAME, APP_VERSION, type HealthResponse, type SystemInfo } from '@flowforge/shared';
import { requireAuth, sessionMiddleware } from '../auth/session.js';
import type { AppServices } from '../app.js';
import { notFound } from '../http/errors.js';
import { authRouter } from './auth.js';
import { binaryDataRouter } from './binary-data.js';
import { credentialsRouter, credentialTypesRouter } from './credentials.js';
import { examplesRouter } from './examples.js';
import { qrRouter } from './qr.js';
import { aiRouter } from './ai.js';
import { settingsRouter } from './settings.js';
import { devRouter } from './dev.js';
import { executionsRouter } from './executions.js';
import { expressionsRouter } from './expressions.js';
import { nodeTypesRouter } from './node-types.js';
import { workflowsRouter } from './workflows.js';
import { tagsRouter } from './tags.js';
import { versionsRouter } from './versions.js';
import { variablesRouter } from './variables.js';
import { templatesRouter } from './templates.js';
import { dashboardRouter } from './dashboard.js';
import { demoRouter } from './demo.js';

export function apiRouter(ctx: AppServices): Router {
  const router = Router();
  router.use(express.json({ limit: '16mb' }));
  router.use(sessionMiddleware(ctx));
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // ── Public ──
  router.get('/health', (_req, res) => {
    ctx.db.prepare('SELECT 1').get();
    const body: HealthResponse = {
      status: 'ok',
      name: APP_NAME,
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.versions.node,
    };
    res.json(body);
  });
  router.use('/auth', authRouter(ctx));

  // ── Everything below needs a signed-in user ──
  router.use(requireAuth);

  router.get('/system/info', (_req, res) => {
    const body: SystemInfo = {
      version: APP_VERSION,
      nodeVersion: process.versions.node,
      publicUrl: ctx.config.publicUrl,
      publicUrlSource: ctx.config.publicUrlSource,
      port: ctx.config.port,
      localUrl: ctx.config.localUrl,
      dataDir: ctx.config.dataDir,
      startedAt: ctx.startedAt.toISOString(),
    };
    res.json(body);
  });

  router.use('/workflows/:id/versions', versionsRouter(ctx));
  router.use('/workflows', workflowsRouter(ctx));
  router.use('/tags', tagsRouter(ctx));
  router.use('/variables', variablesRouter(ctx));
  router.use('/templates', templatesRouter(ctx));
  router.use('/dashboard', dashboardRouter(ctx));
  router.use('/node-types', nodeTypesRouter(ctx));
  router.use('/expressions', expressionsRouter(ctx));
  router.use('/executions', executionsRouter(ctx));
  router.use('/binary-data', binaryDataRouter(ctx));
  router.use('/credentials', credentialsRouter(ctx));
  router.use('/credential-types', credentialTypesRouter(ctx));
  router.use('/qr', qrRouter());
  router.use('/examples', examplesRouter(ctx));
  router.use('/settings', settingsRouter(ctx));
  router.use('/ai', aiRouter(ctx));
  router.use('/demo', demoRouter(ctx));
  if (ctx.config.devApi) router.use('/dev', devRouter(ctx));

  router.use((req, _res, next) => next(notFound(`API route not found: ${req.method} ${req.originalUrl}`)));
  return router;
}
