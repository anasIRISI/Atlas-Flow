import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body: Buffer;
}

export interface MockServer {
  url: string;
  port: number;
  /** Every request received, in order. */
  requests: RecordedRequest[];
  reset(): void;
  close(): Promise<void>;
}

/** A port nothing listens on (taken, then released). */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const ITEMS = Array.from({ length: 7 }, (_v, i) => ({ id: i + 1, name: `item ${i + 1}` }));

const queryOf = (url: URL) => {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    out[key] = all.length > 1 ? all : all[0]!;
  }
  return out;
};

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** Local server standing in for "the internet": echo, status codes, redirects, pagination, auth, files, GraphQL. */
export async function startMockServer(options: { https?: boolean } = {}): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const flaky = new Map<string, number>();
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const body = await readBody(req);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]));
    const method = req.method ?? 'GET';
    const query = queryOf(url);
    requests.push({ method, path: url.pathname, query, headers, body });
    const base = `${options.https ? 'https' : 'http'}://${req.headers.host}`;
    const type = headers['content-type'] ?? '';
    const parsed = () => {
      const text = body.toString('utf8');
      if (type.includes('json')) {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return text;
        }
      }
      if (type.includes('x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
      return text;
    };
    const path = url.pathname;
    const num = (name: string, fallback: number) => Number(url.searchParams.get(name) ?? fallback);

    if (path === '/echo') return json(res, 200, { method, path, query, headers, body: parsed(), bodyLength: body.length });
    if (path.startsWith('/status/')) {
      const code = Number(path.split('/')[2]);
      if (code === 204 || code === 304) return void res.writeHead(code).end();
      if (code < 400) return json(res, code, { ok: true, status: code });
      return json(res, code, { error: `status ${code}`, detail: 'Something specific went wrong' });
    }
    if (path === '/text') return void res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('plain text ✓');
    if (path === '/html') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><h1>Mock page</h1><a href="/next">Next</a></body></html>');
    if (path === '/xml') return void res.writeHead(200, { 'content-type': 'application/xml' }).end('<feed><entry>1</entry></feed>');
    if (path === '/file') return void res.writeHead(200, { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="pixel.png"' }).end(PNG);
    if (path === '/download/report.pdf') return void res.writeHead(200, { 'content-type': 'application/pdf' }).end(Buffer.from('%PDF-1.4 mock'));
    if (path === '/utf8name') return void res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt" }).end('cv');
    if (path === '/bad-json') return void res.writeHead(200, { 'content-type': 'application/json' }).end('<<not json>>');
    if (path === '/no-type') return void res.writeHead(200).end('{"guessed":true}');
    if (path === '/empty') return void res.writeHead(204).end();
    if (path === '/array') return json(res, 200, [{ id: 1 }, { id: 2 }, 3]);
    if (path === '/slow') {
      await new Promise((r) => setTimeout(r, num('ms', 500)));
      return json(res, 200, { slow: true });
    }
    if (path.startsWith('/redirect/')) {
      const left = Number(path.split('/')[2]);
      if (left <= 0) return json(res, 200, { redirected: true, method, authorization: headers.authorization ?? null });
      return void res.writeHead(302, { location: `/redirect/${left - 1}` }).end();
    }
    if (path === '/see-other') return void res.writeHead(303, { location: '/echo?after=303' }).end();
    if (path === '/moved') return void res.writeHead(307, { location: '/echo?after=307' }).end();
    if (path === '/cross') return void res.writeHead(302, { location: String(url.searchParams.get('to')) }).end();
    if (path === '/flaky') {
      const key = String(url.searchParams.get('key') ?? 'default');
      const attempt = (flaky.get(key) ?? 0) + 1;
      flaky.set(key, attempt);
      if (attempt <= num('fail', 2)) return json(res, 503, { error: 'try again', attempt });
      return json(res, 200, { ok: true, attempts: attempt });
    }
    if (path === '/items') {
      const size = num('size', 3);
      const page = num('page', 1);
      return json(res, 200, ITEMS.slice((page - 1) * size, page * size));
    }
    if (path === '/offset') {
      const limit = num('limit', 3);
      const offset = num('offset', 0);
      return json(res, 200, { items: ITEMS.slice(offset, offset + limit), total: ITEMS.length });
    }
    if (path === '/cursor') {
      const after = num('after', 0);
      const data = ITEMS.slice(after, after + 3);
      const next = after + 3 < ITEMS.length ? `${base}/cursor?after=${after + 3}` : null;
      return json(res, 200, { data, next }, next ? { link: `<${next}>; rel="next"` } : {});
    }
    if (path === '/relative-next') {
      const page = num('page', 1);
      return json(res, 200, { data: [{ page }], next: page < 3 ? `/relative-next?page=${page + 1}` : '' });
    }
    if (path === '/until-404') {
      const page = num('page', 1);
      return page > 2 ? json(res, 404, { error: 'no more pages' }) : json(res, 200, [{ page }]);
    }
    if (path === '/search') {
      const page = Number((parsed() as { page?: number }).page ?? 1);
      return json(res, 200, { results: ITEMS.slice((page - 1) * 4, page * 4), hasMore: page * 4 < ITEMS.length });
    }
    if (path === '/endless') return json(res, 200, [{ page: num('page', 1) }]);
    if (path === '/auth/basic') {
      return headers.authorization === `Basic ${Buffer.from('ada:s3cret-pw').toString('base64')}` ? json(res, 200, { user: 'ada' }) : json(res, 401, { error: 'bad credentials' }, { 'www-authenticate': 'Basic' });
    }
    if (path === '/auth/bearer') return headers.authorization === 'Bearer tok-12345' ? json(res, 200, { token: 'ok' }) : json(res, 401, { error: 'bad token' });
    if (path === '/auth/header') return headers['x-api-key'] === 'key-12345' ? json(res, 200, { key: 'ok' }) : json(res, 403, { error: 'bad key' });
    if (path === '/auth/query') {
      // A sloppy API that repeats the whole URL (with the key) in its error message.
      return url.searchParams.get('api_key') === 'q-12345' && !url.searchParams.has('fail') ? json(res, 200, { query: 'ok' }) : json(res, 401, { error: `invalid request ${req.url}` });
    }
    if (path === '/graphql') {
      const payload = method === 'GET' ? { query: String(url.searchParams.get('query') ?? ''), variables: JSON.parse(String(url.searchParams.get('variables') ?? '{}')) as unknown, operationName: url.searchParams.get('operationName') } : (parsed() as { query?: string; variables?: unknown; operationName?: string });
      const q = String(payload.query ?? '');
      if (q.includes('plainText')) return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html>Not GraphQL</html>');
      if (q.includes('bad400')) return json(res, 400, { errors: [{ message: 'Syntax Error: Unexpected Name "bad400"' }] });
      if (q.includes('boom')) return json(res, 200, { data: null, errors: [{ message: 'Cannot query field "boom" on type "Query".' }, { message: 'Second problem' }] });
      if (q.includes('secure') && headers.authorization !== 'Bearer tok-12345') return json(res, 401, { message: 'Unauthorized' });
      return json(res, 200, { data: { echo: { variables: payload.variables ?? null, operationName: payload.operationName ?? null, method, xTest: headers['x-test'] ?? null } } });
    }
    if (path === '/upload') return json(res, 200, { contentType: type, raw: body.toString('latin1') });
    return json(res, 404, { error: `no route ${path}` });
  };

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handler(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    });
  };
  const tls = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tls');
  const server: Server = options.https ? createHttpsServer({ key: readFileSync(join(tls, 'key.pem')), cert: readFileSync(join(tls, 'cert.pem')) }, listener) : createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `${options.https ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    requests,
    reset() {
      requests.length = 0;
      flaky.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
