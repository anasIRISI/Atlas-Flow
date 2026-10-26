import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CredentialSummary, Item, JsonObject, WorkflowNode } from '@flowforge/shared';
import { BinaryStore } from '../src/engine/binary-store.js';
import { redact } from '../src/nodes/_shared/http-client.js';
import { emit, out, run, wf } from './engine-helpers.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { closedPort, PNG, startMockServer, type MockServer } from './http-mock.js';
import { chain, node, signedIn, type Agent } from './trigger-helpers.js';

const store = new BinaryStore(mkdtempSync(join(tmpdir(), 'ff-bin-')));
let mock: MockServer;
let other: MockServer;
let secure: MockServer;

beforeAll(async () => {
  [mock, other, secure] = await Promise.all([startMockServer(), startMockServer(), startMockServer({ https: true })]);
});
afterAll(async () => {
  await Promise.all([mock.close(), other.close(), secure.close()]);
});
beforeEach(() => {
  mock.reset();
  other.reset();
  secure.reset();
});

type Run = Awaited<ReturnType<typeof run>>;
/** Trigger → Data → HTTP Request ("Node"), run with the plain engine (no credentials needed). */
const http = (params: JsonObject, data: JsonObject[] = [{}], extra: Partial<WorkflowNode> = {}): Promise<Run> =>
  run(wf([['T', 'manual'], ['Data', 'test.emit', emit(data)], ['Node', 'flowforge.httpRequest', params, extra]], [['T', 'Data'], ['Data', 'Node']]), {}, {}, { binaryStore: store });
const first = async (params: JsonObject, data?: JsonObject[], extra?: Partial<WorkflowNode>) => {
  const r = await http(params, data, extra);
  expect(r.error?.message, JSON.stringify(r.error)).toBeUndefined();
  return out(r, 'Node')[0] as JsonObject & { headers: Record<string, string>; query: JsonObject; body: unknown };
};
const itemsOf = (r: Run): Item[] => r.runData.Node?.[0]?.data.main[0] ?? [];
const pairs = (o: Record<string, unknown>) => Object.entries(o).map(([name, value]) => ({ name, value }));

describe('HTTP Request: requests', () => {
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('%s', async (method) => {
    const echo = await first({ method, url: `${mock.url}/echo` });
    expect(echo).toMatchObject({ method, path: '/echo' });
    expect(echo.headers['user-agent']).toBe('FlowForge/0.1');
  });

  it('HEAD has no body: the status is returned, the headers on request', async () => {
    expect(await first({ method: 'HEAD', url: `${mock.url}/echo` })).toEqual({ statusCode: 200, statusMessage: 'OK' });
    const full = await first({ method: 'HEAD', url: `${mock.url}/echo`, options: { fullResponse: true } });
    expect(full).toMatchObject({ body: null, statusCode: 200 });
    expect(full.headers['content-type']).toMatch(/application\/json/);
    expect(mock.requests[0]!.method).toBe('HEAD');
  });

  it('query parameters: fields, JSON, lists, merged with the ones in the URL, expressions per item', async () => {
    const fields = await first({ url: `${mock.url}/echo?fixed=1`, sendQuery: true, queryParameters: pairs({ q: 'a b&c', n: 5, empty: '' }) });
    expect(fields.query).toEqual({ fixed: '1', q: 'a b&c', n: '5', empty: '' });
    const asJson = await first({ url: `${mock.url}/echo`, sendQuery: true, specifyQuery: 'json', jsonQuery: '{"page": 2, "tags": ["x", "y"], "deep": {"a": 1}}' });
    expect(asJson.query).toEqual({ page: '2', tags: ['x', 'y'], deep: '{"a":1}' });
    const r = await http({ url: `=${mock.url}/echo?id={{ $json.id }}`, sendQuery: true, queryParameters: [{ name: 'who', value: '={{ $json.name }}' }] }, [{ id: 1, name: 'Ada' }, { id: 2, name: 'Alan' }]);
    expect(out(r, 'Node').map((j) => j.query)).toEqual([{ id: '1', who: 'Ada' }, { id: '2', who: 'Alan' }]);
    expect(itemsOf(r).map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
    // sendQuery off: the fields are ignored.
    expect((await first({ url: `${mock.url}/echo`, queryParameters: pairs({ q: 'x' }) })).query).toEqual({});
  });

  it('headers: fields or JSON', async () => {
    const fields = await first({ url: `${mock.url}/echo`, sendHeaders: true, headerParameters: pairs({ 'X-Trace': 'abc', Accept: 'text/csv' }) });
    expect(fields.headers).toMatchObject({ 'x-trace': 'abc', accept: 'text/csv' });
    const asJson = await first({ url: `${mock.url}/echo`, sendHeaders: true, specifyHeaders: 'json', jsonHeaders: '{"X-Number": 7, "User-Agent": "custom/1"}' });
    expect(asJson.headers).toMatchObject({ 'x-number': '7', 'user-agent': 'custom/1' });
    expect((await http({ url: `${mock.url}/echo`, sendHeaders: true, headerParameters: pairs({ 'bad name': 'x' }) })).error).toMatchObject({ message: '"bad name" is not a valid header name' });
    expect((await http({ url: `${mock.url}/echo`, sendHeaders: true, specifyHeaders: 'json', jsonHeaders: '{oops' })).error?.message).toMatch(/^The headers JSON is not valid JSON/);
  });
});

describe('HTTP Request: body types', () => {
  it('JSON from fields (types kept) or from raw JSON with expressions', async () => {
    const fields = await first({ method: 'POST', url: `${mock.url}/echo`, sendBody: true, bodyParameters: [{ name: 'name', value: 'Ada' }, { name: 'age', value: '={{ $json.age }}' }, { name: 'tags', value: '={{ $json.tags }}' }] }, [{ age: 36, tags: ['a'] }]);
    expect(fields.headers['content-type']).toBe('application/json');
    expect(fields.body).toEqual({ name: 'Ada', age: 36, tags: ['a'] });
    const raw = await first({ method: 'PUT', url: `${mock.url}/echo`, sendBody: true, specifyBody: 'json', jsonBody: '={ "user": "{{ $json.name }}", "double": {{ $json.age * 2 }}, "nested": { "ok": true } }' }, [{ name: 'Ada', age: 21 }]);
    expect(raw.body).toEqual({ user: 'Ada', double: 42, nested: { ok: true } });
    const whole = await first({ method: 'POST', url: `${mock.url}/echo`, sendBody: true, specifyBody: 'json', jsonBody: '={{ $json }}' }, [{ a: [1, 2] }]);
    expect(whole.body).toEqual({ a: [1, 2] });
    expect((await http({ method: 'POST', url: `${mock.url}/echo`, sendBody: true, specifyBody: 'json', jsonBody: '{ name: Ada }' })).error).toMatchObject({
      hint: 'Check the quotes and commas. Names and text need double quotes: {"name": "Ada"}.',
    });
  });

  it('form urlencoded', async () => {
    const echo = await first({ method: 'POST', url: `${mock.url}/echo`, sendBody: true, contentType: 'form-urlencoded', formParameters: pairs({ name: 'Ada Lovelace', note: 'a&b=c' }) });
    expect(echo.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(echo.body).toEqual({ name: 'Ada Lovelace', note: 'a&b=c' });
    expect(mock.requests[0]!.body.toString()).toBe('name=Ada+Lovelace&note=a%26b%3Dc');
  });

  it('multipart form-data with text fields and a file of the item', async () => {
    const r = await run(
      wf(
        [
          ['T', 'manual'],
          ['File', 'test.makeFile'],
          ['Node', 'flowforge.httpRequest', { method: 'POST', url: `${mock.url}/upload`, sendBody: true, contentType: 'multipart-form-data', multipartParameters: { values: [{ parameterType: 'formData', name: 'title', value: '=Table {{ $json.name }}' }, { parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data' }] } }],
        ],
        [['T', 'File'], ['File', 'Node']],
      ),
      {},
      {},
      { binaryStore: store },
    );
    const sent = out(r, 'Node')[0] as { contentType: string; raw: string };
    expect(sent.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(sent.raw).toContain('name="title"\r\n\r\nTable table');
    expect(sent.raw).toMatch(/name="file"; filename="table.csv"\r\nContent-Type: text\/csv\r\n\r\na,b\n1,2/);
  });

  it('raw text with its own content type, and a file as the whole body', async () => {
    const raw = await first({ method: 'POST', url: `${mock.url}/echo`, sendBody: true, contentType: 'raw', rawContentType: 'text/xml', body: '<a>1</a>' });
    expect(raw.headers['content-type']).toBe('text/xml');
    expect(raw.body).toBe('<a>1</a>');
    const binary = await run(
      wf([['T', 'manual'], ['File', 'test.makeFile'], ['Node', 'flowforge.httpRequest', { method: 'PUT', url: `${mock.url}/echo`, sendBody: true, contentType: 'binaryData' }]], [['T', 'File'], ['File', 'Node']]),
      {},
      {},
      { binaryStore: store },
    );
    expect(out(binary, 'Node')[0]).toMatchObject({ body: 'a,b\n1,2', bodyLength: 7, headers: { 'content-type': 'text/csv' } });
    expect((await http({ method: 'POST', url: `${mock.url}/echo`, sendBody: true, contentType: 'binaryData', inputDataFieldName: 'photo' })).error?.message).toBe('Item 0 has no binary property "photo"');
  });
});

describe('HTTP Request: responses', () => {
  it('autodetect: JSON list → one item per element, text, files', async () => {
    expect(out(await http({ url: `${mock.url}/array` }), 'Node')).toEqual([{ id: 1 }, { id: 2 }, { data: 3 }]);
    expect(out(await http({ url: `${mock.url}/array`, options: { splitIntoItems: false } }), 'Node')).toEqual([{ data: [{ id: 1 }, { id: 2 }, 3] }]);
    expect(out(await http({ url: `${mock.url}/text` }), 'Node')).toEqual([{ data: 'plain text ✓' }]);
    expect(out(await http({ url: `${mock.url}/xml`, options: { outputPropertyName: 'xml' } }), 'Node')).toEqual([{ xml: '<feed><entry>1</entry></feed>' }]);
    expect(out(await http({ url: `${mock.url}/no-type` }), 'Node')).toEqual([{ guessed: true }]);
    // Announced as JSON but it is not: the text is still returned.
    expect(out(await http({ url: `${mock.url}/bad-json` }), 'Node')).toEqual([{ data: '<<not json>>' }]);
    expect(out(await http({ url: `${mock.url}/empty` }), 'Node')).toEqual([{ statusCode: 204, statusMessage: 'No Content' }]);
  });

  it('binary download: stored as a file with name and type', async () => {
    const r = await http({ url: `${mock.url}/file` });
    expect(out(r, 'Node')).toEqual([{ fileName: 'pixel.png', mimeType: 'image/png', fileSize: PNG.length }]);
    const ref = itemsOf(r)[0]!.binary!.data!;
    expect(ref).toMatchObject({ fileName: 'pixel.png', mimeType: 'image/png', fileExtension: 'png' });
    expect((await store.read(ref)).equals(PNG)).toBe(true);
    // The name comes from the URL when the server does not give one; UTF-8 names are decoded.
    expect(out(await http({ url: `${mock.url}/download/report.pdf` }), 'Node')[0]).toMatchObject({ fileName: 'report.pdf', mimeType: 'application/pdf' });
    expect(out(await http({ url: `${mock.url}/utf8name` }), 'Node')[0]).toMatchObject({ fileName: 'résumé.txt' });
    // Any answer can be kept as a file.
    const asFile = await http({ url: `${mock.url}/array`, options: { responseFormat: 'file', outputPropertyName: 'download' } });
    expect((await store.read(itemsOf(asFile)[0]!.binary!.download!)).toString()).toBe('[{"id":1},{"id":2},3]');
  });

  it('explicit formats, full response, never error', async () => {
    expect(out(await http({ url: `${mock.url}/array`, options: { responseFormat: 'text' } }), 'Node')).toEqual([{ data: '[{"id":1},{"id":2},3]' }]);
    expect((await http({ url: `${mock.url}/text`, options: { responseFormat: 'json' } })).error).toMatchObject({ hint: 'Set "Response Format" to Text (or Autodetect) in the options.' });
    const full = await first({ url: `${mock.url}/echo?x=1`, options: { fullResponse: true } });
    expect(full).toMatchObject({ statusCode: 200, statusMessage: 'OK', body: { query: { x: '1' } } });
    expect(full.headers['content-type']).toBe('application/json; charset=utf-8');
    const never = await first({ url: `${mock.url}/status/418`, options: { neverError: true, fullResponse: true } });
    expect(never).toMatchObject({ statusCode: 418, body: { error: 'status 418' } });
    expect(await first({ url: `${mock.url}/status/500`, options: { neverError: true } })).toEqual({ error: 'status 500', detail: 'Something specific went wrong' });
  });
});

describe('HTTP Request: errors', () => {
  it('4xx / 5xx: status, start of the body and a hint', async () => {
    const notFound = await http({ url: `${mock.url}/status/404` });
    expect(notFound.status).toBe('error');
    expect(notFound.error).toMatchObject({
      message: 'The server answered 404 Not Found',
      description: '{"error":"status 404","detail":"Something specific went wrong"}',
      hint: 'Nothing exists at this address: check the URL (and the HTTP method).',
      node: 'Node',
      itemIndex: 0,
    });
    expect((await http({ url: `${mock.url}/status/429` })).error?.hint).toMatch(/Too many requests/);
    expect((await http({ url: `${mock.url}/status/503` })).error?.hint).toMatch(/problem is on the server side/);
    expect((await http({ url: `${mock.url}/status/401` })).error?.hint).toMatch(/needs valid credentials/);
  });

  it('per-item errors follow "On Error"', async () => {
    const data = [{ code: 200 }, { code: 404 }, { code: 200 }];
    const url = `=${mock.url}/status/{{ $json.code }}`;
    const stop = await http({ url }, data);
    expect(stop.error).toMatchObject({ message: 'The server answered 404 Not Found', itemIndex: 1 });
    expect(mock.requests).toHaveLength(2);
    const go = await http({ url }, data, { onError: 'continueRegularOutput' });
    expect(go.status).toBe('success');
    expect(out(go, 'Node').map((j) => j.error ?? 'ok')).toEqual(['ok', 'The server answered 404 Not Found', 'ok']);
    const routed = await http({ url }, data, { onError: 'continueErrorOutput' });
    expect(out(routed, 'Node', 0)).toHaveLength(2);
    expect(out(routed, 'Node', 1)).toEqual([{ code: 404, error: 'The server answered 404 Not Found' }]);
  });

  it('timeout: fails fast and says so', async () => {
    const started = Date.now();
    const r = await http({ url: `${mock.url}/slow?ms=3000`, options: { timeout: 300 } });
    expect(r.error?.message).toBe(`No answer from 127.0.0.1:${mock.port} within 0.3 s`);
    expect(r.error?.hint).toMatch(/Raise the timeout/);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(out(await http({ url: `${mock.url}/slow?ms=200`, options: { timeout: 2000 } }), 'Node')).toEqual([{ slow: true }]);
  });

  it('unreachable server and bad URLs', async () => {
    const port = await closedPort();
    expect((await http({ url: `http://127.0.0.1:${port}/x` })).error).toMatchObject({ message: `Connection refused by 127.0.0.1:${port}`, hint: 'Nothing is listening there. Is the server running, and is the port right?' });
    expect((await http({ url: 'http://127.0.0.1:1/x' })).error).toMatchObject({ message: 'Port 1 is blocked for web requests' });
    expect((await http({ url: '' })).error?.message).toBe('The URL is empty');
    expect((await http({ url: 'api.example.com/users' })).error).toMatchObject({ message: '"api.example.com/users" is not a valid URL', hint: 'Did you mean https://api.example.com/users ?' });
    expect((await http({ url: 'ftp://example.com/file' })).error?.message).toBe('Only http:// and https:// URLs are supported (got ftp://)');
    expect((await http({ url: 'file:///etc/passwd' })).error?.message).toBe('Only http:// and https:// URLs are supported (got file://)');
  });

  it('retry on fail (node setting): a flaky server succeeds on the third try', async () => {
    const r = await http({ url: `${mock.url}/flaky?key=a&fail=2` }, [{}], { retryOnFail: true, maxTries: 3, waitBetweenTries: 20 });
    expect(r.status).toBe('success');
    expect(out(r, 'Node')).toEqual([{ ok: true, attempts: 3 }]);
    expect(mock.requests).toHaveLength(3);
    const gaveUp = await http({ url: `${mock.url}/flaky?key=b&fail=5` }, [{}], { retryOnFail: true, maxTries: 2, waitBetweenTries: 20 });
    expect(gaveUp.error?.message).toBe('The server answered 503 Service Unavailable');
  });

  it('a stopped execution cancels the request', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const started = Date.now();
    const r = await run(wf([['T', 'manual'], ['Node', 'flowforge.httpRequest', { url: `${mock.url}/slow?ms=5000` }]], [['T', 'Node']]), { signal: controller.signal });
    expect(r.status).toBe('canceled');
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

describe('HTTP Request: redirects and SSL', () => {
  it('follows redirects, up to the limit', async () => {
    expect(out(await http({ url: `${mock.url}/redirect/3` }), 'Node')).toEqual([{ redirected: true, method: 'GET', authorization: null }]);
    expect(mock.requests.map((r) => r.path)).toEqual(['/redirect/3', '/redirect/2', '/redirect/1', '/redirect/0']);
    const tooMany = await http({ url: `${mock.url}/redirect/5`, options: { maxRedirects: 2 } });
    expect(tooMany.error?.message).toBe('Too many redirects (more than 2)');
    expect(tooMany.error?.hint).toContain('/redirect/2');
  });

  it('without following: the 3xx answer itself is returned', async () => {
    const r = await first({ url: `${mock.url}/redirect/2`, options: { followRedirects: false, fullResponse: true } });
    expect(r).toMatchObject({ statusCode: 302, headers: { location: '/redirect/1' } });
    expect(mock.requests).toHaveLength(1);
  });

  it('303 turns a POST into a GET, 307 keeps method and body', async () => {
    const seeOther = await first({ method: 'POST', url: `${mock.url}/see-other`, sendBody: true, bodyParameters: pairs({ a: 1 }) });
    expect(seeOther).toMatchObject({ method: 'GET', query: { after: '303' }, bodyLength: 0 });
    const moved = await first({ method: 'POST', url: `${mock.url}/moved`, sendBody: true, bodyParameters: pairs({ a: 1 }) });
    expect(moved).toMatchObject({ method: 'POST', query: { after: '307' }, body: { a: 1 } });
  });

  it('a redirect to another server does not take the Authorization header along', async () => {
    const headers = pairs({ Authorization: 'Bearer my-token', 'X-Other': 'kept' });
    const same = await first({ url: `${mock.url}/cross?to=${encodeURIComponent('/echo')}`, sendHeaders: true, headerParameters: headers });
    expect(same.headers.authorization).toBe('Bearer my-token');
    const cross = await first({ url: `${mock.url}/cross?to=${encodeURIComponent(`${other.url}/echo`)}`, sendHeaders: true, headerParameters: headers });
    expect(cross.headers.authorization).toBeUndefined();
    expect(cross.headers['x-other']).toBe('kept');
    expect(other.requests).toHaveLength(1);
  });

  it('self-signed HTTPS: refused by default, accepted with "Ignore SSL Issues"', async () => {
    const refused = await http({ url: `${secure.url}/echo` });
    expect(refused.error).toMatchObject({ message: `The SSL certificate of 127.0.0.1:${secure.port} is not trusted`, hint: 'Only if you trust this server: turn on "Ignore SSL Issues" in the options.' });
    expect(secure.requests).toHaveLength(0);
    expect(await first({ url: `${secure.url}/echo?tls=1`, options: { allowUnauthorizedCerts: true } })).toMatchObject({ query: { tls: '1' } });
    // The setting is per node: the next request without it is refused again.
    expect((await http({ url: `${secure.url}/echo` })).error?.message).toMatch(/SSL certificate/);
  });
});

describe('HTTP Request: pagination', () => {
  const ids = (r: Run) => out(r, 'Node').map((j) => j.id);
  const page = (more: JsonObject = {}) => ({ paginationMode: 'updateAParameterInEachRequest', paginationParameters: { values: [{ type: 'qs', name: 'page', value: '{{ $pageCount + 1 }}' }] }, ...more });

  it('update a parameter in each request (page number) until the response is empty', async () => {
    const r = await http({ url: `${mock.url}/items?size=3`, ...page() });
    expect(ids(r)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(mock.requests.map((q) => q.query.page)).toEqual(['1', '2', '3', '4']);
    expect(itemsOf(r).every((i) => JSON.stringify(i.pairedItem) === '{"item":0}')).toBe(true);
  });

  it('offset pagination with an expression as the stop condition', async () => {
    const r = await http({
      url: `${mock.url}/offset?limit=3`,
      paginationMode: 'updateAParameterInEachRequest',
      paginationParameters: { values: [{ type: 'qs', name: 'offset', value: '{{ $pageCount * 3 }}' }] },
      paginationCompleteWhen: 'other',
      completeExpression: '{{ $response.body.items.length < 3 }}',
    });
    expect(mock.requests.map((q) => q.query.offset)).toEqual(['0', '3', '6']);
    expect(out(r, 'Node').map((j) => (j.items as JsonObject[]).length)).toEqual([3, 3, 1]);
  });

  it('the response contains the next URL (body, header, or a relative path)', async () => {
    const body = await http({ url: `${mock.url}/cursor`, paginationMode: 'responseContainsNextURL', nextURL: '{{ $response.body.next }}', options: { splitIntoItems: false } });
    expect(out(body, 'Node').flatMap((j) => (j.data as JsonObject[]).map((d) => d.id))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(mock.requests.map((q) => q.query.after ?? '0')).toEqual(['0', '3', '6']);
    mock.reset();
    const header = await http({ url: `${mock.url}/cursor`, paginationMode: 'responseContainsNextURL', nextURL: '{{ ($response.headers.link ?? "").split(";")[0].replace(/[<>]/g, "") }}' });
    expect(mock.requests).toHaveLength(3);
    expect(out(header, 'Node')).toHaveLength(3);
    mock.reset();
    const relative = await http({ url: `${mock.url}/relative-next`, paginationMode: 'responseContainsNextURL', nextURL: '{{ $response.body.next }}' });
    expect(out(relative, 'Node').map((j) => (j.data as JsonObject[])[0]!.page)).toEqual([1, 2, 3]);
  });

  it('stop on a status code; a body parameter; the page limit; a pause between requests', async () => {
    const until = await http({ url: `${mock.url}/until-404`, ...page({ paginationCompleteWhen: 'receiveSpecificStatusCodes', statusCodesWhenComplete: '404, 410' }) });
    expect(until.status).toBe('success');
    expect(out(until, 'Node')).toEqual([{ page: 1 }, { page: 2 }]);
    mock.reset();
    const search = await http({
      method: 'POST',
      url: `${mock.url}/search`,
      sendBody: true,
      bodyParameters: pairs({ term: 'x' }),
      paginationMode: 'updateAParameterInEachRequest',
      paginationParameters: { values: [{ type: 'body', name: 'page', value: '{{ $pageCount + 1 }}' }, { type: 'headers', name: 'X-Page', value: 'p{{ $pageCount }}' }] },
      paginationCompleteWhen: 'other',
      completeExpression: '{{ !$response.body.hasMore }}',
    });
    expect(out(search, 'Node').map((j) => (j.results as JsonObject[]).length)).toEqual([4, 3]);
    expect(mock.requests.map((q) => JSON.parse(q.body.toString()))).toEqual([{ term: 'x', page: 1 }, { term: 'x', page: 2 }]);
    expect(mock.requests.map((q) => q.headers['x-page'])).toEqual(['p0', 'p1']);
    mock.reset();
    const started = Date.now();
    const capped = await http({ url: `${mock.url}/endless`, ...page({ maxRequests: 3, requestInterval: 120 }) });
    expect(out(capped, 'Node')).toEqual([{ page: 1 }, { page: 2 }, { page: 3 }]);
    expect(mock.requests).toHaveLength(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(230);
  });

  it('pagination problems are explained', async () => {
    expect((await http({ url: `${mock.url}/until-404`, ...page() })).error?.message).toBe('The server answered 404 Not Found');
    expect((await http({ url: `${mock.url}/items`, paginationMode: 'updateAParameterInEachRequest', paginationParameters: { values: [] } })).error?.message).toBe('Pagination: add a parameter to update in each request');
    expect((await http({ url: `${mock.url}/items`, ...page({ paginationCompleteWhen: 'other', completeExpression: '{{ $response.body.nope.length }}' }) })).error?.message).toMatch(/^Pagination: the complete expression failed/);
    expect((await http({ url: `${mock.url}/echo`, paginationMode: 'updateAParameterInEachRequest', paginationParameters: { values: [{ type: 'body', name: 'page', value: '1' }] } })).error?.message).toBe('Pagination cannot set the body field "page"');
    // $response and $pageCount exist only there.
    expect((await http({ url: `=${mock.url}/echo?x={{ $pageCount }}` })).error).toMatchObject({
      message: '$pageCount is not available here',
      hint: 'It only exists in the pagination settings of the HTTP Request node, while the node runs.',
    });
  });
});

describe('HTTP Request: authentication through credentials', () => {
  const SECRETS = ['s3cret-pw', 'tok-12345', 'key-12345', 'q-12345'];
  let t: TestApp;
  let agent: Agent;

  beforeEach(async () => {
    t = await makeTestApp();
    agent = await signedIn(t);
  });
  afterEach(async () => {
    await t.close();
  });

  const credential = async (type: string, data: JsonObject, name = type) => (await agent.post('/api/credentials').send({ name, type, data })).body as CredentialSummary;
  const call = async (parameters: JsonObject, credentials?: WorkflowNode['credentials'], type = 'httpRequest') => {
    const nodes = [node('Start', 'manualTrigger'), node('Call', type, parameters, credentials ? { credentials } : {})];
    const res = await agent.post('/api/dev/run').send({ name: 'Auth', nodes, connections: chain('Start', 'Call') });
    return res.body as { executionId: string; status: string; output: JsonObject[][]; error?: JsonObject & { message: string } };
  };

  it('basic, bearer, header and query credentials are sent the right way', async () => {
    await credential('httpBasicAuth', { user: 'ada', password: 's3cret-pw' });
    await credential('httpBearerAuth', { token: 'tok-12345' });
    await credential('httpHeaderAuth', { name: 'X-API-Key', value: 'key-12345' });
    await credential('httpQueryAuth', { name: 'api_key', value: 'q-12345' });
    expect((await call({ url: `${mock.url}/auth/basic`, authentication: 'basicAuth' })).output).toEqual([[{ user: 'ada' }]]);
    expect((await call({ url: `${mock.url}/auth/bearer`, authentication: 'bearerAuth' })).output).toEqual([[{ token: 'ok' }]]);
    expect((await call({ url: `${mock.url}/auth/header`, authentication: 'headerAuth' })).output).toEqual([[{ key: 'ok' }]]);
    expect((await call({ url: `${mock.url}/auth/query?other=1`, authentication: 'queryAuth' })).output).toEqual([[{ query: 'ok' }]]);
    expect(mock.requests[3]!.query).toEqual({ other: '1', api_key: 'q-12345' });
    // With "None" nothing is added, even though credentials exist.
    const none = await call({ url: `${mock.url}/echo`, authentication: 'none' });
    expect((none.output[0]![0]!.headers as JsonObject).authorization).toBeUndefined();
    expect(none.output[0]![0]!.query).toEqual({});
  });

  it('the credential selected on the node wins over the default one', async () => {
    await credential('httpBearerAuth', { token: 'wrong-token' }, 'Default token');
    const good = await credential('httpBearerAuth', { token: 'tok-12345' }, 'Good token');
    expect((await call({ url: `${mock.url}/auth/bearer`, authentication: 'bearerAuth' })).status).toBe('error');
    expect((await call({ url: `${mock.url}/auth/bearer`, authentication: 'bearerAuth' }, { httpBearerAuth: { id: good.id, name: good.name } })).output).toEqual([[{ token: 'ok' }]]);
  });

  it('missing credential, and a refused credential (401) that names it', async () => {
    const missing = await call({ url: `${mock.url}/auth/bearer`, authentication: 'bearerAuth' });
    expect(missing.error).toMatchObject({ message: 'Bearer Auth credentials are missing', credentialType: 'httpBearerAuth', node: 'Call' });
    expect(mock.requests).toHaveLength(0);
    const wrong = await credential('httpBasicAuth', { user: 'ada', password: 'nope-nope' });
    const refused = await call({ url: `${mock.url}/auth/basic`, authentication: 'basicAuth' });
    expect(refused.error).toMatchObject({ message: 'The server answered 401 Unauthorized', credentialType: 'httpBasicAuth', credentialId: wrong.id, hint: 'The server refused the credential: check its values.' });
  });

  it('secrets never reach execution data, error messages or the stored workflow', async () => {
    const basic = await credential('httpBasicAuth', { user: 'ada', password: 's3cret-pw' });
    await credential('httpBearerAuth', { token: 'tok-12345' });
    await credential('httpHeaderAuth', { name: 'X-API-Key', value: 'key-12345' });
    await credential('httpQueryAuth', { name: 'api_key', value: 'q-12345' });
    const runs = [
      // /echo returns every header and query parameter it received: none of it may be stored… except that
      // the answer of the server is the user's data. So the secrets are checked on error paths and metadata.
      await call({ url: `${mock.url}/status/500`, authentication: 'basicAuth' }),
      await call({ url: `${mock.url}/status/404`, authentication: 'bearerAuth' }),
      await call({ url: `${mock.url}/status/403`, authentication: 'headerAuth' }),
      // This API repeats the URL (with the key) in its error body.
      await call({ url: `${mock.url}/auth/query?fail=1`, authentication: 'queryAuth' }),
      await call({ url: `${mock.url}/redirect/9`, authentication: 'queryAuth', options: { maxRedirects: 1 } }),
      await call({ url: `http://127.0.0.1:1/x`, authentication: 'queryAuth' }),
      await call({ url: `${mock.url}/auth/basic`, authentication: 'basicAuth', options: { fullResponse: true } }, { httpBasicAuth: { id: basic.id, name: basic.name } }),
    ];
    expect(runs.map((r) => r.status)).toEqual(['error', 'error', 'error', 'error', 'error', 'error', 'success']);
    expect(runs[3]!.error!.description).toBe('{"error":"invalid request /auth/query?fail=1&api_key=***"}');
    const encodedBasic = Buffer.from('ada:s3cret-pw').toString('base64');
    for (const r of runs) {
      const detail = (await agent.get(`/api/executions/${r.executionId}`)).body as JsonObject;
      const text = JSON.stringify([r, detail]);
      for (const secret of [...SECRETS, encodedBasic]) expect(text.includes(secret), `${secret} in ${text.slice(0, 300)}`).toBe(false);
    }
    expect(redact('key=abc123&x=a%20b', ['abc123', 'a b', 'ab'])).toBe('key=***&x=***');
  });

  it('GraphQL uses the same credentials', async () => {
    await credential('httpBearerAuth', { token: 'tok-12345' });
    const ok = await call({ endpoint: `${mock.url}/graphql`, query: '{ secure }', authentication: 'bearerAuth' }, undefined, 'graphql');
    expect(ok.output).toEqual([[{ data: { echo: { variables: {}, operationName: null, method: 'POST', xTest: null } } }]]);
    const none = await call({ endpoint: `${mock.url}/graphql`, query: '{ secure }' }, undefined, 'graphql');
    expect(none.error).toMatchObject({ message: 'The server answered 401 Unauthorized' });
  });
});

describe('GraphQL', () => {
  const gql = (params: JsonObject, data: JsonObject[] = [{}], extra: Partial<WorkflowNode> = {}): Promise<Run> =>
    run(wf([['T', 'manual'], ['Data', 'test.emit', emit(data)], ['Node', 'flowforge.graphql', { endpoint: `${mock.url}/graphql`, ...params }, extra]], [['T', 'Data'], ['Data', 'Node']]));

  it('POST: query, variables (with expressions), operation name and headers', async () => {
    const r = await gql({ query: 'query Get($id: ID!) { user(id: $id) { name } }', variables: '={ "id": "{{ $json.id }}", "first": 5 }', operationName: 'Get', headerParameters: [{ name: 'X-Test', value: 'yes' }] }, [{ id: 'u1' }, { id: 'u2' }]);
    expect(out(r, 'Node')).toEqual([
      { data: { echo: { variables: { id: 'u1', first: 5 }, operationName: 'Get', method: 'POST', xTest: 'yes' } } },
      { data: { echo: { variables: { id: 'u2', first: 5 }, operationName: 'Get', method: 'POST', xTest: 'yes' } } },
    ]);
    expect(JSON.parse(mock.requests[0]!.body.toString())).toEqual({ query: 'query Get($id: ID!) { user(id: $id) { name } }', variables: { id: 'u1', first: 5 }, operationName: 'Get' });
    expect(mock.requests[0]!.headers['content-type']).toBe('application/json');
  });

  it('GET: the query travels in the URL', async () => {
    const r = await gql({ requestMethod: 'GET', query: '{ hello }', variables: '{"a": 1}' });
    expect(out(r, 'Node')).toEqual([{ data: { echo: { variables: { a: 1 }, operationName: null, method: 'GET', xTest: null } } }]);
    expect(mock.requests[0]!.query).toEqual({ query: '{ hello }', variables: '{"a":1}' });
  });

  it('GraphQL errors fail the node (also when the server answers 200), unless asked not to', async () => {
    const r = await gql({ query: '{ boom }' });
    expect(r.error).toMatchObject({
      message: 'GraphQL error: Cannot query field "boom" on type "Query".',
      description: '2 errors: Cannot query field "boom" on type "Query". · Second problem',
      itemIndex: 0,
    });
    expect((await gql({ query: '{ bad400 }' })).error?.message).toBe('GraphQL error: Syntax Error: Unexpected Name "bad400"');
    expect(out(await gql({ query: '{ boom }', options: { ignoreGraphqlErrors: true } }), 'Node')[0]).toMatchObject({ data: null, errors: [{ message: 'Cannot query field "boom" on type "Query".' }, { message: 'Second problem' }] });
    expect(out(await gql({ query: '={{ $json.q }}' }, [{ q: '{ ok }' }, { q: '{ boom }' }], { onError: 'continueRegularOutput' }), 'Node').map((j) => (j.error ? 'error' : 'ok'))).toEqual(['ok', 'error']);
  });

  it('bad input: empty query, invalid variables, an endpoint that is not GraphQL', async () => {
    expect((await gql({ query: ' ' })).error).toMatchObject({ message: 'The GraphQL query is empty' });
    expect((await gql({ query: '{ a }', variables: '{oops' })).error?.message).toMatch(/^Variables is not valid JSON/);
    expect((await gql({ query: '{ a }', variables: '[1]' })).error?.message).toBe('Variables must be a JSON object, e.g. {"code": "FR"}');
    expect((await gql({ query: '{ plainText }' })).error).toMatchObject({ message: 'The server did not answer with GraphQL JSON' });
    expect((await gql({ endpoint: `${mock.url}/status/500`, query: '{ a }' })).error?.message).toBe('The server answered 500 Internal Server Error');
    expect((await gql({ endpoint: '', query: '{ a }' })).error?.message).toBe('The URL is empty');
  });
});
