import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { normalizeFormFields, renderFormMessage } from '@flowforge/shared';
import type { ExecutionsRepo } from '../db/repositories/executions.js';
import type { BinaryStore } from '../engine/binary-store.js';
import type { ExecutionService } from '../engine/execution-service.js';
import { withDefaults } from '../engine/params.js';
import type { Logger } from '../logger.js';
import { formInvalidResponse, formPageResponse, formSuccessResponse, isBot, processSubmission, queryStrings, themeOf, wantsJson } from '../nodes/_shared/form.js';
import type { NodeRegistry } from '../nodes/registry.js';
import { parseRequest, RequestError } from '../triggers/request.js';
import { sendWebhookResponse, type WebhookService } from '../triggers/webhook-service.js';

type OnLimit = (req: Request, res: Response, retryAfterSeconds: number) => void;

const jsonTooMany: OnLimit = (_req, res) => {
  res.status(429).json({ message: 'Too many requests. Slow down and try again in a minute.' });
};

/** Fixed-window limiter per client IP for public endpoints. */
function rateLimit(perMinute: number, onLimit: OnLimit = jsonTooMany): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + 60_000 };
      hits.set(key, entry);
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    if (++entry.count > perMinute) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      onLimit(req, res, retryAfter);
      return;
    }
    next();
  };
}

/** Public handlers must never crash the server: errors become a JSON 500. */
const safe =
  (logger: Logger, fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, _next: NextFunction) => {
    fn(req, res).catch((err) => {
      logger.error(`Public route ${req.method} ${req.path} failed`, err);
      if (!res.headersSent) res.status(500).json({ message: 'Internal error while handling this request.' });
    });
  };

const joinPath = (p: unknown) => (Array.isArray(p) ? p.join('/') : String(p ?? ''));

const headersOf = (req: Request) => ({ accept: String(req.headers.accept ?? '') });

export interface PublicRouterOptions {
  webhooks: WebhookService;
  executions: ExecutionService;
  executionsRepo: ExecutionsRepo;
  nodes: NodeRegistry;
  logger: Logger;
  binaryStore: BinaryStore;
  ratePerMinute: number;
  /** Form submissions per minute per IP (anti-spam). */
  formRatePerMinute: number;
  formMaxBodyBytes: number;
}

export function publicRouter(o: PublicRouterOptions): Router {
  const router = Router();
  router.use(['/webhook', '/webhook-test', '/webhook-waiting', '/form', '/form-test', '/form-waiting', '/chat', '/chat-test'], rateLimit(o.ratePerMinute));

  // Submissions have their own, much lower limit; the answer matches what the form page expects.
  const submitLimit = rateLimit(o.formRatePerMinute, (req, res, retryAfter) => {
    const message = `Too many submissions from your network. Try again in ${retryAfter} seconds.`;
    if (wantsJson(headersOf(req))) res.status(429).json({ ok: false, message });
    else res.status(429).type('html').send(renderFormMessage({ title: 'Please slow down', message, tone: 'error' }));
  });
  const limitPosts: RequestHandler = (req, res, next) => (req.method === 'POST' ? submitLimit(req, res, next) : next());

  router.all('/webhook/*path', safe(o.logger, (req, res) => o.webhooks.handle('prod', req, res, joinPath(req.params.path))));
  router.all('/webhook-test/*path', safe(o.logger, (req, res) => o.webhooks.handle('test', req, res, joinPath(req.params.path))));
  router.all('/webhook-waiting/:executionId', safe(o.logger, (req, res) => o.webhooks.handleWaiting(req, res, String(req.params.executionId))));

  // ── Form Trigger ───────────────────────────────────────────────────────────
  router.all('/form/*path', limitPosts, safe(o.logger, (req, res) => o.webhooks.handle('prod', req, res, joinPath(req.params.path), 'form')));
  router.all('/form-test/*path', limitPosts, safe(o.logger, (req, res) => o.webhooks.handle('test', req, res, joinPath(req.params.path), 'form')));

  // ── Chat Trigger (GET = the chat page, POST = one message) ──────────────────
  router.all('/chat/*path', limitPosts, safe(o.logger, (req, res) => o.webhooks.handle('prod', req, res, joinPath(req.params.path), 'chat')));
  router.all('/chat-test/*path', limitPosts, safe(o.logger, (req, res) => o.webhooks.handle('test', req, res, joinPath(req.params.path), 'chat')));

  // ── Wait node "On Form Submitted" ──────────────────────────────────────────
  const waitingForm = (id: string) => {
    const waiting = o.executionsRepo.getWaiting(id);
    if (!waiting || waiting.kind !== 'form') return undefined;
    const node = waiting.workflow.nodes.find((n) => n.name === waiting.node);
    const type = node ? o.nodes.get(node.type) : undefined;
    if (!node || !type) return undefined;
    const p = withDefaults(type.properties, node.parameters ?? {});
    return {
      title: String(p.formTitle || 'Form'),
      description: String(p.formDescription || ''),
      fields: normalizeFormFields(p.formFields),
      theme: themeOf(p.formTheme),
      buttonLabel: String(p.formButtonLabel || 'Submit'),
      completion: String(p.formCompletionMessage || 'Thank you, your answer was submitted.'),
    };
  };
  const notWaiting = (req: Request, res: Response) => {
    const title = 'This form is closed';
    const message = 'It was already submitted, or the workflow stopped waiting for it.';
    if (wantsJson(headersOf(req))) res.status(404).json({ ok: false, message: `${title}. ${message}` });
    else res.status(404).type('html').send(renderFormMessage({ title, message, tone: 'notice' }));
  };

  router.get('/form-waiting/:executionId', (req, res) => {
    const form = waitingForm(String(req.params.executionId));
    if (!form) return void notWaiting(req, res);
    sendWebhookResponse(res, formPageResponse(200, { ...form, action: req.originalUrl.split('?')[0]!, query: queryStrings(req.query as Record<string, unknown>), mode: 'waiting' }));
  });

  router.post(
    '/form-waiting/:executionId',
    limitPosts,
    safe(o.logger, async (req, res) => {
      const id = String(req.params.executionId);
      const form = waitingForm(id);
      if (!form) return void notWaiting(req, res);
      const json = wantsJson(headersOf(req));
      let parsed;
      try {
        parsed = await parseRequest(req, o.formMaxBodyBytes);
      } catch (err) {
        const e = err instanceof RequestError ? err : new RequestError(400, 'Could not read the request');
        if (json) res.status(e.status).json({ ok: false, message: e.message });
        else res.status(e.status).type('html').send(renderFormMessage({ title: 'The form could not be sent', message: e.message, tone: 'error', theme: form.theme }));
        return;
      }
      const success = { title: form.title, message: form.completion, theme: form.theme };
      if (isBot(parsed.body)) return sendWebhookResponse(res, formSuccessResponse(json, success));
      const { result, binary } = await processSubmission(form.fields, parsed.body, parsed.files, (data, fileName, mimeType) =>
        o.binaryStore.store(id, data, fileName, mimeType),
      );
      if (Object.keys(result.errors).length) {
        return sendWebhookResponse(res, formInvalidResponse(json, { ...form, action: req.originalUrl.split('?')[0]!, mode: 'waiting' }, result));
      }
      const item = { json: { ...(result.values as Record<string, never>), submittedAt: new Date().toISOString() }, ...(Object.keys(binary).length ? { binary } : {}) };
      const started = o.executions.resume(id, [item]);
      if (!started) return void notWaiting(req, res);
      sendWebhookResponse(res, formSuccessResponse(json, success));
    }),
  );

  return router;
}
