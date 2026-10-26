import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const WEBHOOK_ID = '123456789012345678';
export const WEBHOOK_TOKEN = 'tK3n_SECRET-abcDEF0123456789xyz';

export interface DiscordRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Parsed JSON body (undefined when empty). */
  body?: Record<string, unknown>;
}

/** One scripted answer, used once, for the next request (whatever it is). */
export interface Scripted {
  status: number;
  body?: unknown;
  /** Sent as is (no JSON encoding), e.g. HTML or garbage. */
  raw?: string;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface DiscordMock {
  /** Webhook URL as the user would paste it: http://127.0.0.1:<port>/api/webhooks/<id>/<token> */
  url: string;
  port: number;
  requests: DiscordRequest[];
  /** Answers used first, one per request, before the normal behavior. */
  script: Scripted[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** Local stand-in for the Discord webhook API (127.0.0.1, free port). Records every request. */
export async function startDiscordMock(): Promise<DiscordMock> {
  const requests: DiscordRequest[] = [];
  const script: Scripted[] = [];
  const messages = new Map<string, Record<string, unknown>>();
  let nextId = 1000;

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://mock');
      const text = await readBody(req);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
      let body: Record<string, unknown> | undefined;
      if (text) {
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          body = undefined;
        }
      }
      requests.push({ method: req.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body });

      const send = (status: number, payload?: unknown, extra: Record<string, string> = {}) => {
        if (status === 204 || payload === undefined) {
          res.writeHead(status, extra);
          return res.end();
        }
        res.writeHead(status, { 'content-type': 'application/json', ...extra });
        res.end(JSON.stringify(payload));
      };

      const scripted = script.shift();
      if (scripted) {
        if (scripted.delayMs) await new Promise((r) => setTimeout(r, scripted.delayMs));
        if (scripted.raw !== undefined) {
          res.writeHead(scripted.status, { 'content-type': 'text/html', ...scripted.headers });
          return res.end(scripted.raw);
        }
        return send(scripted.status, scripted.body, scripted.headers);
      }

      const match = /^\/api(?:\/v\d+)?\/webhooks\/(\d+)\/([\w-]+)(?:\/messages\/(\w+))?$/.exec(url.pathname);
      if (!match) return send(404, { message: '404: Not Found', code: 0 });
      const [, id, token, messageId] = match;
      if (id !== WEBHOOK_ID) return send(404, { message: 'Unknown Webhook', code: 10015 });
      if (token !== WEBHOOK_TOKEN) return send(401, { message: 'Invalid Webhook Token', code: 50027 });

      if (!messageId) {
        if (req.method === 'GET') return send(200, { id, type: 1, name: 'Captain Hook', channel_id: '777', guild_id: '888', application_id: null, token: WEBHOOK_TOKEN, url: `https://discord.com/api/webhooks/${id}/${token}` });
        if (req.method === 'POST') {
          if (!body || (body.content === undefined && body.embeds === undefined)) return send(400, { message: 'Cannot send an empty message', code: 50006 });
          const message = { id: String(nextId++), channel_id: '777', webhook_id: id, type: 0, content: body.content ?? '', embeds: body.embeds ?? [], timestamp: '2026-10-12T09:00:00.000000+00:00', flags: body.flags ?? 0, tts: body.tts === true, author: { username: body.username ?? 'Captain Hook', bot: true } };
          messages.set(message.id, message);
          return url.searchParams.get('wait') === 'true' ? send(200, message) : send(204);
        }
        return send(405, { message: '405: Method Not Allowed', code: 0 });
      }
      const message = messages.get(messageId!);
      if (!message) return send(404, { message: 'Unknown Message', code: 10008 });
      if (req.method === 'GET') return send(200, message);
      if (req.method === 'DELETE') {
        messages.delete(messageId!);
        return send(204);
      }
      if (req.method === 'PATCH') {
        Object.assign(message, { ...(body?.content !== undefined ? { content: body.content } : {}), ...(body?.embeds !== undefined ? { embeds: body.embeds } : {}), edited_timestamp: '2026-10-12T09:05:00.000000+00:00' });
        return send(200, message);
      }
      return send(405, { message: '405: Method Not Allowed', code: 0 });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
    port,
    requests,
    script,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
