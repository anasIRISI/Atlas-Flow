import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

export interface MockApi {
  url: string;
  requests: { method: string; path: string; headers: Record<string, string>; body: string }[];
  close(): Promise<void>;
}

/** A small API on localhost standing in for the internet (the e2e server calls it for real). */
export async function startMockApi(): Promise<MockApi> {
  const requests: MockApi['requests'] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://mock');
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? 'GET', path: url.pathname, headers, body });
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const ok = (pass: boolean, name: string) => (pass ? json(200, { access: 'granted', by: name }) : json(401, { error: `${name} refused` }));
      switch (url.pathname) {
        case '/auth/basic':
          return ok(headers.authorization === `Basic ${Buffer.from('ada:basic-pw-1').toString('base64')}`, 'basic');
        case '/auth/bearer':
          return ok(headers.authorization === 'Bearer bearer-tok-1', 'bearer');
        case '/auth/header':
          return ok(headers['x-api-key'] === 'header-key-1', 'header');
        case '/auth/query':
          return ok(url.searchParams.get('api_key') === 'query-key-1', 'query');
        case '/file':
          res.writeHead(200, { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="pixel.png"' });
          return void res.end(PNG);
        case '/items': {
          const page = Number(url.searchParams.get('page') ?? 1);
          return json(200, page > 2 ? [] : [{ id: page * 10 + 1, page }, { id: page * 10 + 2, page }]);
        }
        case '/orders':
          return json(201, { created: true, method: req.method, trace: headers['x-trace'] ?? null, received: body ? (JSON.parse(body) as unknown) : null, dry: url.searchParams.get('dry') });
        default:
          return json(404, { error: 'not found' });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
