import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const TG_TOKEN = '123456789:AAHsecretTokenForTestsOnly_xyz';

export interface TgFile {
  field: string;
  fileName: string;
  contentType: string;
  data: Buffer;
}

export interface TgRequest {
  method: string;
  token: string;
  contentType: string;
  /** JSON body, or the text fields of a multipart body. */
  body: Record<string, unknown>;
  files: TgFile[];
  at: number;
}

export interface ScriptedAnswer {
  status?: number;
  /** JSON body (default `{ ok: false }`), or a raw string for malformed answers. */
  body?: unknown;
  raw?: string;
  /** Never answers (until the mock closes): for timeout tests. */
  hang?: boolean;
}

export interface TelegramMock {
  url: string;
  token: string;
  requests: TgRequest[];
  /** Requests of one method, in order. */
  calls(method: string): TgRequest[];
  /** Queue an update; `update_id` is assigned. Returns it. */
  push(update: Record<string, unknown>): { update_id: number } & Record<string, unknown>;
  /** The next requests for `method` get these answers, in order (then the normal behaviour resumes). */
  script(method: string, ...answers: ScriptedAnswer[]): void;
  /** Updates not yet confirmed by an `offset` (Telegram deletes an update once an offset above it is sent). */
  pending(): number[];
  inFlightGetUpdates(): number;
  maxConcurrentGetUpdates(): number;
  /** Offsets received by getUpdates, in order. */
  offsets(): unknown[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

/** Minimal multipart/form-data reader (text fields + files). */
export function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; files: TgFile[] } {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const fields: Record<string, string> = {};
  const files: TgFile[] = [];
  if (!boundary) return { fields, files };
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let pos = body.indexOf(delimiter);
  while (pos !== -1) {
    const start = pos + delimiter.length;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    const part = body.subarray(start + 2, next - 2); // skip CRLF after the boundary and before the next one
    const split = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, split).toString('utf8');
    const data = part.subarray(split + 4);
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? '';
    const fileName = /filename="([^"]*)"/.exec(head)?.[1];
    if (fileName !== undefined) files.push({ field: name, fileName, contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? '', data: Buffer.from(data) });
    else fields[name] = data.toString('utf8');
    pos = next;
  }
  return { fields, files };
}

/** Local stand-in for api.telegram.org: the methods of the contract, long polling, scripted failures. */
export async function startTelegramMock(options: { token?: string; pollMs?: number; username?: string } = {}): Promise<TelegramMock> {
  const token = options.token ?? TG_TOKEN;
  const pollMs = options.pollMs ?? 150;
  const requests: TgRequest[] = [];
  const scripts = new Map<string, ScriptedAnswer[]>();
  let queue: Array<{ update_id: number } & Record<string, unknown>> = [];
  let lastId = 100;
  let messageId = 1000;
  let inFlight = 0;
  let maxInFlight = 0;
  const offsets: unknown[] = [];
  const waiters = new Set<() => void>();
  const open = new Set<{ finish(): void; dead(): boolean }>();
  const hanging = new Set<ServerResponse>();

  const send = (res: ServerResponse, status: number, body: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const ok = (res: ServerResponse, result: unknown) => send(res, 200, { ok: true, result });

  const server = createServer(async (req, res) => {
    const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    const raw = await readBody(req);
    if (!match) return send(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    const [, urlToken, method] = match as unknown as [string, string, string];
    const contentType = String(req.headers['content-type'] ?? '');
    let body: Record<string, unknown> = {};
    let files: TgFile[] = [];
    if (contentType.startsWith('multipart/form-data')) {
      const parsed = parseMultipart(raw, contentType);
      body = parsed.fields;
      files = parsed.files;
    } else if (raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      } catch {
        return send(res, 400, { ok: false, error_code: 400, description: 'Bad Request: invalid JSON' });
      }
    }
    requests.push({ method, token: urlToken, contentType, body, files, at: Date.now() });

    const scripted = scripts.get(method)?.shift();
    if (scripted) {
      if (scripted.hang) {
        hanging.add(res);
        return;
      }
      if (scripted.raw !== undefined) {
        res.writeHead(scripted.status ?? 200, { 'content-type': 'application/json' });
        return void res.end(scripted.raw);
      }
      return send(res, scripted.status ?? 200, scripted.body ?? { ok: false });
    }

    if (!urlToken.includes(':')) return send(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    if (urlToken !== token) return send(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });

    const message = (extra: Record<string, unknown>) => ({ message_id: ++messageId, from: { id: 1, is_bot: true, first_name: 'FlowForgeBot' }, chat: { id: Number(body.chat_id) || body.chat_id, type: 'private' }, date: 1_700_000_000, ...extra });

    switch (method) {
      case 'getMe':
        return ok(res, { id: 1, is_bot: true, first_name: 'FlowForge Bot', username: options.username ?? 'flowforge_test_bot' });
      case 'deleteWebhook':
        return ok(res, true);
      case 'getUpdates': {
        offsets.push(body.offset);
        const offset = typeof body.offset === 'number' ? body.offset : undefined;
        if (offset !== undefined && offset < 0) {
          const last = queue[queue.length - 1];
          if (last) queue = [last]; // Telegram forgets everything before the last update
          return ok(res, queue.slice());
        }
        if (offset !== undefined) queue = queue.filter((u) => u.update_id >= offset);
        // An aborted request is noticed by the server a few ms after the client hung up: give it that moment, so the
        // count below only sees requests that are really still waiting (two live loops would overlap for 100+ ms).
        await new Promise((r) => setTimeout(r, 15));
        for (const stale of [...open]) if (stale.dead()) stale.finish();
        if (res.destroyed || req.socket.destroyed) return; // the client already gave up
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        let finished = false;
        const entry = { finish: () => finish(), dead: () => req.socket.destroyed || req.socket.readableEnded };
        const finish = () => {
          if (finished) return;
          finished = true;
          open.delete(entry);
          inFlight--;
          waiters.delete(wake);
          clearTimeout(timer);
        };
        const answer = () => {
          finish();
          ok(res, queue.slice(0, Number(body.limit) || 100));
        };
        const wake = () => {
          if (queue.length) answer();
        };
        const wait = Math.min(Number(body.timeout ?? 0) * 1000, pollMs);
        const timer = setTimeout(answer, wait);
        res.on('close', finish);
        req.socket.once('end', finish); // the client hung up (aborted): the request is over from its point of view
        waiters.add(wake);
        open.add(entry);
        if (queue.length || wait === 0) answer();
        return;
      }
      case 'sendMessage':
        return ok(res, message({ text: body.text, ...(body.reply_markup ? { reply_markup: body.reply_markup } : {}) }));
      case 'sendPhoto':
        return ok(res, message({ photo: [{ file_id: 'photo-1', file_unique_id: 'u1', width: 1, height: 1 }], ...(body.caption ? { caption: body.caption } : {}) }));
      case 'sendDocument':
        return ok(res, message({ document: { file_id: 'doc-1', file_unique_id: 'u2', file_name: files[0]?.fileName ?? 'remote.pdf' }, ...(body.caption ? { caption: body.caption } : {}) }));
      case 'editMessageText':
        return ok(res, message({ message_id: body.message_id, text: body.text, edit_date: 1_700_000_100 }));
      case 'deleteMessage':
        return ok(res, true);
      case 'answerCallbackQuery':
        return ok(res, true);
      case 'getChat':
        return ok(res, { id: Number(body.chat_id), type: 'private', first_name: 'Ada', username: 'ada' });
      default:
        return send(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    requests,
    calls: (method) => requests.filter((r) => r.method === method),
    push(update) {
      const full = { update_id: ++lastId, ...update };
      queue.push(full);
      for (const wake of [...waiters]) wake();
      return full;
    },
    script(method, ...answers) {
      scripts.set(method, [...(scripts.get(method) ?? []), ...answers]);
    },
    pending: () => queue.map((u) => u.update_id),
    inFlightGetUpdates: () => inFlight,
    maxConcurrentGetUpdates: () => maxInFlight,
    offsets: () => offsets.slice(),
    async close() {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A text message update. */
export const textUpdate = (text: string, o: { chat?: number; user?: number } = {}) => ({
  message: { message_id: Math.floor(Math.random() * 1e6), from: { id: o.user ?? 42, is_bot: false, first_name: 'Bob' }, chat: { id: o.chat ?? 555, type: 'private', first_name: 'Bob' }, date: 1_700_000_000, text },
});
