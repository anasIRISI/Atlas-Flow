import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { ExecutionDetail, Item, JsonObject, WorkflowData } from '@flowforge/shared';
import { renderFormMessage, SESSION_COOKIE } from '@flowforge/shared';
import type { CredentialsProvider, NodeType } from '../engine/types.js';
import { CredentialError, FlowError } from '../engine/errors.js';
import type { ExecutionsRepo } from '../db/repositories/executions.js';
import type { BinaryStore } from '../engine/binary-store.js';
import type { ExecutionService, StartedExecution, WebhookResponder } from '../engine/execution-service.js';
import { getExpressionEngine } from '../engine/expressions/engine.js';
import { isNoExpression, withDefaults } from '../engine/params.js';
import type { UrlPrefix, WebhookHandleResult, WebhookRequestData, WebhookResponse } from '../engine/types.js';
import type { Logger } from '../logger.js';
import type { NodeRegistry } from '../nodes/registry.js';
import { parseRequest, RequestError } from './request.js';
import type { WebhookKind, WebhookRegistration, WebhookRegistry } from './webhook-registry.js';

export interface WebhookServiceOptions {
  registry: WebhookRegistry;
  nodes: NodeRegistry;
  executions: ExecutionService;
  executionsRepo: ExecutionsRepo;
  binaryStore: BinaryStore;
  logger: Logger;
  publicUrl: string;
  maxBodyBytes: number;
  /** Body limit of public forms (file uploads). */
  formMaxBodyBytes?: number;
  timezone?: string;
  credentials?: CredentialsProvider;
  /** A test webhook was called (single shot): the editor is told which execution started. */
  onTestReceived?(reg: WebhookRegistration, executionId: string): void;
}

const json = (res: Response, status: number, body: unknown) => res.status(status).json(body);

const wantsJson = (req: Request) => /application\/json/i.test(String(req.headers.accept ?? ''));

/** Error answer of a public form: JSON for the page's fetch() call, otherwise a styled HTML page. */
function formProblem(req: Request, res: Response, status: number, title: string, message: string) {
  if (wantsJson(req)) {
    json(res, status, { ok: false, message: `${title}. ${message}` });
    return;
  }
  res.status(status).type('html').send(renderFormMessage({ title, message, tone: 'error' }));
}

/**
 * Request headers as workflow data. The FlowForge session cookie is removed: a signed-in user calling a
 * webhook or form from the same browser must not leak their session into execution data.
 */
export function requestHeaders(req: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    let text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    if (key === 'cookie') {
      text = text
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith(`${SESSION_COOKIE}=`))
        .join('; ');
      if (!text) continue;
    }
    headers[key] = text;
  }
  return headers;
}

/**
 * Webhook settings are read before the workflow runs, so expressions see no item data
 * ($now, $workflow, $vars work; $json is empty). Parameters marked noDataExpression stay raw.
 */
function resolveStatic(type: NodeType, workflow: WorkflowData, nodeName: string, raw: JsonObject, timezone: string): JsonObject {
  const params = withDefaults(type.properties, raw);
  const engine = getExpressionEngine();
  const scope = {
    workflow,
    runData: {},
    nodeName,
    inputs: [[]],
    sources: [],
    runIndex: 0,
    mode: 'webhook' as const,
    executionId: '',
    timezone,
    variables: {},
    env: null,
  };
  return Object.fromEntries(
    Object.entries(params).map(([k, v]) => [k, isNoExpression(type.properties, k) ? v : engine.resolve(v, scope, 0)]),
  );
}

/** Writes a WebhookResponse (JSON / text / bytes / redirect / empty). */
export function sendWebhookResponse(res: Response, response: WebhookResponse): void {
  if (res.headersSent) return;
  for (const [k, v] of Object.entries(response.headers ?? {})) if (k) res.setHeader(k, v);
  if (response.redirect) {
    res.redirect(response.statusCode >= 300 && response.statusCode < 400 ? response.statusCode : 307, response.redirect);
    return;
  }
  res.status(response.statusCode);
  const body = response.body;
  if (body === undefined || body === null || body === '') res.end();
  else if (Buffer.isBuffer(body)) res.end(body);
  else if (typeof body === 'string') {
    if (!res.getHeader('content-type')) res.type('text/plain');
    res.send(body);
  } else res.json(body);
}

/** Receives webhook calls, starts executions and answers according to the response mode. */
export class WebhookService {
  constructor(private readonly o: WebhookServiceOptions) {}

  async handle(kind: WebhookKind, req: Request, res: Response, rawPath: string, urlPrefix: UrlPrefix = 'webhook'): Promise<void> {
    const method = req.method.toUpperCase();
    // Forms and chats are pages for people: their problems are shown as pages too.
    const isChat = urlPrefix === 'chat';
    const isForm = urlPrefix === 'form' || isChat;
    const what = isChat ? 'chat' : urlPrefix === 'form' ? 'form' : 'webhook';
    if (method === 'OPTIONS' && !isForm) return this.preflight(kind, req, res, rawPath);
    const match = this.o.registry.match(kind, method, rawPath, urlPrefix);
    const prefix = kind === 'test' ? `${urlPrefix}-test` : urlPrefix;
    if (!match) {
      if (isChat) {
        return kind === 'test'
          ? formProblem(req, res, 404, 'This test chat is not listening', 'Use the Chat panel of the editor to test: it starts listening for each message.')
          : formProblem(req, res, 404, 'This chat is not available', 'The workflow behind this chat is not active. Activate it in the editor to use this URL.');
      }
      if (isForm) {
        return kind === 'test'
          ? formProblem(req, res, 404, 'This test form is not listening', 'In the editor, open the Form Trigger and click "Listen for test event", then reload this page.')
          : formProblem(req, res, 404, 'This form is not available', 'The workflow behind this form is not active. Activate it in the editor to use this URL.');
      }
      json(res, 404, {
        message: `The requested webhook "${method} ${rawPath}" is not registered.`,
        hint:
          kind === 'test'
            ? 'Click "Listen for test event" on the Webhook node in the editor, then call the test URL (it works once).'
            : 'Activate the workflow to use the production URL (or use the test URL while listening).',
      });
      return;
    }
    if ('methods' in match) {
      res.setHeader('Allow', match.methods.join(', '));
      json(res, 405, { message: `This ${what} accepts ${match.methods.join(', ')} requests, not ${method}.` });
      return;
    }
    const { reg, params } = match;
    const node = reg.workflow.nodes.find((n) => n.name === reg.nodeName);
    const type = node ? this.o.nodes.get(node.type) : undefined;
    if (!node || !type?.webhook) {
      json(res, 500, { message: 'The webhook node no longer exists in this workflow.' });
      return;
    }
    let parameters: JsonObject;
    try {
      parameters = resolveStatic(type, reg.workflow, node.name, node.parameters ?? {}, reg.workflow.settings?.timezone || this.o.timezone || 'UTC');
    } catch (err) {
      json(res, 500, { message: `The ${what} settings contain an invalid expression: ${(err as Error).message}` });
      return;
    }
    if (!isForm) this.applyCors(req, res, type.webhook.cors?.(parameters));

    let parsed;
    try {
      parsed = await parseRequest(req, isForm ? (this.o.formMaxBodyBytes ?? this.o.maxBodyBytes) : this.o.maxBodyBytes);
    } catch (err) {
      const e = err instanceof RequestError ? err : new RequestError(400, 'Could not read the request');
      if (isForm) return formProblem(req, res, e.status, e.status === 413 ? 'The upload is too large' : `The ${what} could not be read`, e.message);
      json(res, e.status, { message: e.message });
      return;
    }
    const request: WebhookRequestData = {
      method,
      params,
      query: req.query as Record<string, unknown>,
      headers: requestHeaders(req),
      body: parsed.body,
      contentType: parsed.contentType,
      rawBody: parsed.rawBody,
      files: parsed.files,
      webhookUrl: `${this.o.publicUrl}/${prefix}/${reg.path}`,
      requestPath: req.originalUrl.split('?')[0] ?? `/${prefix}/${reg.path}`,
      executionMode: kind === 'test' ? 'test' : 'production',
    };
    const folder = `wh-${randomUUID()}`;
    let result: WebhookHandleResult;
    try {
      result = await type.webhook.handle({
        request,
        parameters,
        node,
        storeBinary: (data, fileName, mimeType) => this.o.binaryStore.store(folder, data, fileName, mimeType),
        getCredentials: (credentialType) => {
          if (!type.description.credentials?.some((c) => c.type === credentialType)) {
            throw new FlowError(`Node "${node.name}" does not declare "${credentialType}" credentials`);
          }
          if (!this.o.credentials) throw new CredentialError('Credentials are not available', { credentialType });
          return this.o.credentials.resolve(node, credentialType);
        },
      });
    } catch (err) {
      // Configuration problems (e.g. missing credential): tell the caller without leaking internals.
      const message = err instanceof FlowError ? err.message : 'The request could not be processed.';
      this.o.logger.warn(`${what[0]!.toUpperCase()}${what.slice(1)} "${reg.path}" of "${reg.workflow.name}" failed: ${message}`);
      if (isForm) return formProblem(req, res, 500, `This ${what} is not set up correctly`, message);
      json(res, 500, { message, ...(err instanceof FlowError && err.hint ? { hint: err.hint } : {}) });
      return;
    }
    if ('response' in result) {
      sendWebhookResponse(res, result.response);
      return;
    }
    if (kind === 'test') reg.onUse?.();

    await this.run(res, result, (responder) =>
      this.o.executions.start({
        workflow: reg.workflow,
        mode: kind === 'test' ? 'manual' : 'webhook',
        startNode: reg.nodeName,
        triggerItems: result.items,
        responder,
        ...(kind === 'test' && reg.demo ? { demo: true } : {}),
      }),
    (executionId) => kind === 'test' && this.o.onTestReceived?.(reg, executionId));
  }

  /** /webhook-waiting/:executionId — resumes an execution paused by a Wait node ("On Webhook Call"). */
  async handleWaiting(req: Request, res: Response, executionId: string): Promise<void> {
    const waiting = this.o.executionsRepo.getWaiting(executionId);
    const node = waiting?.workflow.nodes.find((n) => n.name === waiting.node);
    const type = node ? this.o.nodes.get(node.type) : undefined;
    if (!waiting || !node || !type || waiting.kind !== 'webhook') {
      json(res, 404, {
        message: 'No execution is waiting for this URL.',
        hint: 'It may have resumed already, timed out or been stopped.',
      });
      return;
    }
    const parameters = withDefaults(type.properties, node.parameters ?? {});
    const method = String(parameters.httpMethod ?? 'GET').toUpperCase();
    if (req.method.toUpperCase() !== method) {
      res.setHeader('Allow', method);
      json(res, 405, { message: `This resume URL accepts ${method} requests, not ${req.method.toUpperCase()}.` });
      return;
    }
    let parsed;
    try {
      parsed = await parseRequest(req, this.o.maxBodyBytes);
    } catch (err) {
      const e = err instanceof RequestError ? err : new RequestError(400, 'Could not read the request');
      json(res, e.status, { message: e.message });
      return;
    }
    const item: Item = {
      json: {
        headers: requestHeaders(req),
        params: {},
        query: req.query as Record<string, unknown>,
        body: parsed.body as Item['json'][string],
      },
    };
    const mode = String(parameters.responseMode ?? 'onReceived') as 'onReceived' | 'lastNode' | 'responseNode';
    await this.run(res, { items: [item], responseMode: mode, lastNodeData: 'firstEntryJson' }, (responder) => {
      const started = this.o.executions.resume(executionId, [item], responder);
      if (!started) throw new RequestError(409, 'This execution has already been resumed.');
      return started;
    });
  }

  private async run(
    res: Response,
    result: Extract<WebhookHandleResult, { items: Item[] }>,
    start: (responder?: WebhookResponder) => StartedExecution,
    onStarted?: (executionId: string) => void,
  ): Promise<void> {
    const code = result.responseCode ?? 200;
    const headers = result.responseHeaders ?? {};
    try {
      if (result.responseMode === 'responseNode') {
        let resolveResponse!: (r: WebhookResponse) => void;
        const responded = new Promise<WebhookResponse>((r) => (resolveResponse = r));
        let sent = false;
        const started = start({
          send: (response) => {
            if (sent) return false;
            sent = true;
            resolveResponse(response);
            return true;
          },
        });
        onStarted?.(started.executionId);
        const first = await Promise.race([responded.then((r) => ({ r })), started.done.then((d) => ({ d }))]);
        if ('r' in first) return sendWebhookResponse(res, first.r);
        if (sent) return sendWebhookResponse(res, await responded);
        return this.finishWithoutResponse(res, first.d, true);
      }

      const started = start();
      onStarted?.(started.executionId);
      if (result.responseMode === 'onReceived') {
        if (result.complete) return sendWebhookResponse(res, result.complete({ finished: false }));
        sendWebhookResponse(res, { statusCode: code, headers, body: result.onReceivedBody ?? { message: 'Workflow was started' } });
        return;
      }
      // lastNode: wait for the end of the execution.
      const detail = await started.done;
      const runs = detail.lastNodeExecuted ? detail.runData[detail.lastNodeExecuted] : undefined;
      const items = runs?.[runs.length - 1]?.data.main[0] ?? [];
      if (result.complete) return sendWebhookResponse(res, result.complete({ finished: true, status: detail.status, error: detail.error?.message, items: detail.status === 'success' ? items : [] }));
      if (detail.status !== 'success') return this.finishWithoutResponse(res, detail, false);
      switch (result.lastNodeData ?? 'firstEntryJson') {
        case 'allEntries':
          return sendWebhookResponse(res, { statusCode: code, headers, body: items.map((i) => i.json) });
        case 'noData':
          return sendWebhookResponse(res, { statusCode: code, headers });
        case 'firstEntryBinary': {
          const property = result.binaryProperty || 'data';
          const ref = items[0]?.binary?.[property];
          if (!ref) {
            json(res, 500, { message: `The last node has no binary data in property "${property}".` });
            return;
          }
          const data = await this.o.binaryStore.read(ref);
          return sendWebhookResponse(res, { statusCode: code, headers: { 'content-type': ref.mimeType, ...headers }, body: data });
        }
        default:
          return sendWebhookResponse(res, { statusCode: code, headers, body: items[0]?.json ?? {} });
      }
    } catch (err) {
      if (err instanceof RequestError) {
        json(res, err.status, { message: err.message });
        return;
      }
      this.o.logger.error('Webhook handling failed', err);
      json(res, 500, { message: 'The webhook could not be processed.' });
    }
  }

  private finishWithoutResponse(res: Response, detail: ExecutionDetail, respondNodeExpected: boolean) {
    if (detail.status === 'waiting') {
      json(res, 202, { message: 'Workflow is waiting', executionId: detail.id });
    } else if (detail.status !== 'success') {
      json(res, 500, { message: 'Error in workflow', error: detail.error?.message ?? detail.status, node: detail.error?.node ?? null, executionId: detail.id });
    } else if (respondNodeExpected) {
      json(res, 500, {
        message: 'No "Respond to Webhook" node was executed',
        hint: "Add a \"Respond to Webhook\" node on the path the data takes, or change the webhook's response mode.",
        executionId: detail.id,
      });
    }
  }

  private preflight(kind: WebhookKind, req: Request, res: Response, rawPath: string) {
    const match = this.o.registry.match(kind, String(req.headers['access-control-request-method'] ?? 'GET').toUpperCase(), rawPath);
    if (!match || 'methods' in match) {
      res.status(match ? 204 : 404).end();
      return;
    }
    const node = match.reg.workflow.nodes.find((n) => n.name === match.reg.nodeName);
    const type = node ? this.o.nodes.get(node.type) : undefined;
    const origins = type?.webhook?.cors?.(withDefaults(type.properties, node?.parameters ?? {}));
    this.applyCors(req, res, origins);
    res.setHeader('Access-Control-Allow-Methods', [...match.reg.methods, 'OPTIONS'].join(', '));
    res.setHeader('Access-Control-Allow-Headers', String(req.headers['access-control-request-headers'] ?? '*'));
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(204).end();
  }

  private applyCors(req: Request, res: Response, origins: string | undefined) {
    if (!origins) return;
    const origin = String(req.headers.origin ?? '');
    const list = origins.split(',').map((o) => o.trim());
    if (list.includes('*')) res.setHeader('Access-Control-Allow-Origin', '*');
    else if (origin && list.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
  }
}
