import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What the mock received for one generateContent call. */
export interface GeminiCall {
  method: string;
  /** Path and query string, as sent. */
  url: string;
  /** Model id taken from the path. */
  model: string;
  headers: Record<string, string>;
  /** Parsed JSON body (undefined when it was not JSON). */
  body?: any;
  raw: string;
}

export interface MockReply {
  status?: number;
  /** Serialized as JSON. */
  body?: unknown;
  /** Sent as is (to test non-JSON answers). */
  raw?: string;
  /** Wait before answering (timeout tests). */
  delayMs?: number;
}

export interface GeminiMock {
  url: string;
  calls: GeminiCall[];
  /** The next calls get these answers, in order; afterwards the default answer is used. */
  enqueue(...replies: MockReply[]): void;
  close(): Promise<void>;
}

/** A successful generateContent answer. */
export function answer(text: string, extra: Record<string, unknown> = {}): MockReply {
  return {
    body: {
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      ...extra,
    },
  };
}

/** One function call the model asks for. */
export interface MockFunctionCall {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
}

/**
 * An answer where the model calls one or more functions (parallel calls = several parts). The content has a thought part
 * and `thoughtSignature`s like the real API: the agent must send it back unchanged. `content` is what was sent.
 */
export function functionCallReply(calls: MockFunctionCall[], extra: Record<string, unknown> = {}): MockReply & { content: Record<string, unknown> } {
  const content = {
    role: 'model',
    parts: [
      { text: 'I should call a tool.', thought: true, thoughtSignature: 'c2lnLXRob3VnaHQ=' },
      ...calls.map((c, i) => ({
        functionCall: { ...(c.id ? { id: c.id } : {}), name: c.name, args: c.args ?? {} },
        // Only the first call of a parallel group carries a signature in the real API.
        ...(i === 0 ? { thoughtSignature: 'c2lnLWNhbGwtMQ==' } : {}),
      })),
    ],
  };
  return {
    content,
    body: {
      candidates: [{ content, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, totalTokenCount: 24 },
      ...extra,
    },
  };
}

/** An error answer in the documented shape (numeric code + status + details). */
export function apiError(status: number, message: string, details: Record<string, unknown>[] = [], statusName = 'ERROR'): MockReply {
  return { status, body: { error: { code: status, message, status: statusName, details } } };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** Local server standing in for generativelanguage.googleapis.com (127.0.0.1, random port). */
export async function startGeminiMock(): Promise<GeminiMock> {
  const calls: GeminiCall[] = [];
  const queue: MockReply[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await readBody(req);
    const url = req.url ?? '';
    const model = decodeURIComponent(/\/v1beta\/models\/([^:/?]+):generateContent/.exec(url)?.[1] ?? '');
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      body = undefined;
    }
    calls.push({ method: req.method ?? '', url, model, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])), body, raw });
    const reply = queue.shift() ?? answer('Hello from Gemini', { modelVersion: model });
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;
    if (reply.raw !== undefined) {
      res.writeHead(reply.status ?? 200, { 'content-type': 'text/html' });
      res.end(reply.raw);
      return;
    }
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(reply.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    enqueue: (...replies) => void queue.push(...replies),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
