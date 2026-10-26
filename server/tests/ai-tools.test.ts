import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@flowforge/shared';
import { defineNode } from '../src/engine/types.js';
import { codeLimits } from '../src/nodes/transform/code.node.js';
import { out, run, wf, type RunnerExtras } from './engine-helpers.js';
import { getTestRegistry } from './engine-helpers.js';
import { closedPort, startMockServer, type MockServer } from './http-mock.js';
import { startOpenMeteoMock, type OpenMeteoMock } from './open-meteo-mock.js';

// The four AI tools (Calculator, Weather, HTTP Request, Code) called the way the AI Agent calls them: attached to a
// parent node that asks the engine for its tools. Only local mocks, no real network.

const CALCULATOR = 'flowforge.calculatorTool';
const WEATHER = 'flowforge.weatherTool';
const HTTP = 'flowforge.httpRequestTool';
const CODE = 'flowforge.codeTool';

let mock: MockServer;
let meteo: OpenMeteoMock;

beforeAll(async () => {
  [mock, meteo] = await Promise.all([startMockServer(), startOpenMeteoMock()]);
  // Lists what the attached tools tell the model (the harness of the engine only reports their names).
  (await getTestRegistry()).register(
    defineNode({
      description: {
        hidden: true,
        version: 1,
        icon: 'lucide:flask-conical',
        type: 'test.aiDescribe',
        displayName: 'AI Describe',
        description: 'Reports name, description and schema of the attached tools',
        group: 'ai',
        defaults: { name: 'AI Describe' },
        inputs: [{ type: 'main' }, { type: 'ai_tool' }],
        outputs: [{ type: 'main' }],
      },
      properties: [],
      async execute(ctx) {
        const tools = await ctx.getAiTools(0);
        return [[{ json: { tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })) } as unknown as JsonObject }]];
      },
    }),
  );
});
afterAll(async () => {
  await Promise.all([mock.close(), meteo.close()]);
});
beforeEach(() => {
  mock.reset();
  meteo.reset();
});

function cluster(harnessType: string, harness: JsonObject, toolType: string, parameters: JsonObject) {
  const w = wf(
    [
      ['Trigger', 'test.trigger'],
      ['Start', 'test.emit', { items: [{ who: 'ada' }] }],
      ['Harness', harnessType, harness],
      ['Tool', toolType, parameters],
    ],
    [
      ['Trigger', 'Start'],
      ['Start', 'Harness'],
    ],
  );
  w.connections.Tool = { ai_tool: [[{ node: 'Harness', type: 'ai_tool', index: 0 }]] };
  return w;
}

type Run = Awaited<ReturnType<typeof run>>;

/** Calls the tool `tool` with `args` through the engine; returns what the parent saw. */
async function call(toolType: string, parameters: JsonObject, tool: string, args: JsonObject, extras: RunnerExtras = {}) {
  const result: Run = await run(cluster('test.aiHarness', { tool, args }, toolType, parameters), {}, {}, extras);
  const row = out(result, 'Harness')[0] as { result?: unknown; toolError?: string } | undefined;
  return { run: result, result: row?.result as Record<string, unknown> | undefined, error: row?.toolError };
}

/** What the model is told about the tool. */
async function describeTool(toolType: string, parameters: JsonObject = {}, extras: RunnerExtras = {}) {
  const result = await run(cluster('test.aiDescribe', {}, toolType, parameters), {}, {}, extras);
  expect(result.status, JSON.stringify(result.error)).toBe('success');
  return (out(result, 'Harness')[0] as { tools: { name: string; description: string; parameters: JsonObject }[] }).tools[0]!;
}

const bearer = (token = 'tok-12345', type = 'httpBearerAuth') => ({ resolve: () => ({ data: { token }, source: 'credential' as const, id: 'c1', name: type }) });
const credential = (type: string, data: JsonObject) => ({ resolve: () => ({ data: data as never, source: 'credential' as const, id: 'c1', name: type }) });

describe('every tool: name, description, schema and invalid names', () => {
  const tools: [string, JsonObject, string, JsonObject, string[]][] = [
    [CALCULATOR, {}, 'calculator', { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] }, ['expression']],
    [WEATHER, {}, 'get_weather', { type: 'object', properties: { city: { type: 'string' }, days: { type: 'integer' } }, required: ['city'] }, ['city', 'days']],
    [HTTP, { url: 'http://127.0.0.1/x' }, 'http_request', { type: 'object', properties: {} }, []],
    [CODE, { jsCode: 'return 1;' }, 'run_code', { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, ['query']],
  ];

  it.each(tools)('%s gives its default name, a description and a JSON Schema object', async (type, parameters, name, _schema, properties) => {
    const tool = await describeTool(type, parameters);
    expect(tool.name).toBe(name);
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.parameters).toMatchObject({ type: 'object' });
    expect(Object.keys(tool.parameters.properties as object)).toEqual(properties);
  });

  it.each(tools)('%s lets the name and description be overridden', async (type, parameters) => {
    const tool = await describeTool(type, { ...parameters, toolName: 'my_tool_2', toolDescription: 'Use me for X.' });
    expect(tool).toMatchObject({ name: 'my_tool_2', description: 'Use me for X.' });
  });

  it.each(tools)('%s refuses an invalid tool name with a clear error on the tool', async (type, parameters) => {
    for (const bad of ['two words', '1abc', 'a-b', 'x'.repeat(65)]) {
      const result = await run(cluster('test.aiHarness', { tool: 'x' }, type, { ...parameters, toolName: bad }));
      expect(result.status).toBe('error');
      expect(result.error).toMatchObject({ node: 'Tool' });
      expect(result.error?.message).toMatch(/is not a valid tool name/);
    }
  });

  it.each(tools)('%s is a sub-node without execute', async (type) => {
    const node = (await getTestRegistry()).require(type);
    expect(node.execute).toBeUndefined();
    expect(node.description).toMatchObject({ group: 'ai-sub', inputs: [], outputs: [{ type: 'ai_tool' }] });
  });
});

describe('Calculator tool', () => {
  const calc = async (expression: unknown) => call(CALCULATOR, {}, 'calculator', { expression: expression as never });

  it('does arithmetic and returns the expression with a number', async () => {
    const r = await calc('12.5 * (3 + 4)');
    expect(r.run.status).toBe('success');
    expect(r.result).toEqual({ expression: '12.5 * (3 + 4)', result: 87.5 });
    expect((await calc('0.1 + 0.2')).result).toMatchObject({ result: 0.3 });
    expect((await calc('2^10 - 1')).result).toMatchObject({ result: 1023 });
    expect((await calc('17 % 5')).result).toMatchObject({ result: 2 });
  });

  it('knows functions and constants', async () => {
    expect((await calc('sqrt(144)')).result).toMatchObject({ result: 12 });
    expect((await calc('sin(30 deg)')).result).toMatchObject({ result: 0.5 });
    expect((await calc('round(pi, 3)')).result).toMatchObject({ result: 3.142 });
    expect((await calc('mean([1, 2, 3, 6])')).result).toMatchObject({ result: 3 });
  });

  it('converts units and answers with a text', async () => {
    expect((await calc('5 cm to inch')).result).toEqual({ expression: '5 cm to inch', result: '1.9685039370079 inch' });
  });

  it('copes with big numbers and values that are not numbers', async () => {
    expect((await calc('2^100')).result).toMatchObject({ result: 1.2676506002282e30 });
    expect((await calc('factorial(20)')).result).toMatchObject({ result: 2.4329020081766e18 });
    expect((await calc('1 / 0')).result).toMatchObject({ result: 'Infinity' });
    expect((await calc('sqrt(-4)')).result).toMatchObject({ result: '2i' });
  });

  it('explains a syntax error, an unknown function and an empty expression', async () => {
    expect((await calc('2 +')).error).toMatch(/Could not calculate "2 \+"/);
    expect((await calc('foo(3)')).error).toMatch(/Undefined function foo/);
    expect((await calc('   ')).error).toMatch(/expression is empty/);
    expect((await call(CALCULATOR, {}, 'calculator', {})).error).toMatch(/expression is empty/);
  });

  it('blocks the functions that run code or change the instance', async () => {
    for (const name of ['import', 'evaluate', 'parse', 'simplify', 'derivative', 'resolve', 'createUnit', 'config']) {
      const arg = name === 'import' ? '{a: 1}' : name === 'config' ? '{number: "BigNumber"}' : '"1+1"';
      const r = await calc(`${name}(${arg})`);
      expect(r.error, name).toMatch(new RegExp(`Function ${name} is disabled`));
    }
    // compile() and parser() go through evaluate / parse.
    expect((await calc('compile("1+1")')).error).toMatch(/disabled/);
    expect((await calc('parser().evaluate("1+1")')).error).toMatch(/disabled/);
    // The shared instance is intact afterwards.
    expect((await calc('7 * 6')).result).toMatchObject({ result: 42 });
  });

  it('refuses an expression longer than 1000 characters', async () => {
    const r = await calc(`${'1+'.repeat(600)}1`);
    expect(r.error).toMatch(/too long \(1201 characters, the limit is 1000\)/);
    expect((await calc(`${'1+'.repeat(400)}1`)).result).toMatchObject({ result: 401 });
  });

  it('really stops a runaway expression with the time limit', async () => {
    const started = Date.now();
    const r = await calc('sum(range(1, 1e9))');
    expect(r.error).toMatch(/longer than 1 s and was stopped/);
    expect(Date.now() - started).toBeLessThan(5000);
    // And the engine is still fine afterwards.
    expect((await calc('1 + 1')).result).toMatchObject({ result: 2 });
  });
});

describe('Weather tool', () => {
  const weather = (args: JsonObject, parameters: JsonObject = {}) =>
    call(WEATHER, { options: { forecastUrl: meteo.forecastUrl, geocodingUrl: meteo.geocodingUrl }, ...parameters }, 'get_weather', args);

  it('answers for a city with the compact object of the contract', async () => {
    const r = await weather({ city: 'Paris' });
    expect(r.run.status, JSON.stringify(r.run.error)).toBe('success');
    expect(r.result).toMatchObject({
      location: 'Paris, France',
      current: { temperature: 19.8, feelsLike: 18.4, description: 'Partly cloudy', windSpeed: 10.8, humidity: 62 },
      units: { temperature: '°C', windSpeed: 'km/h' },
      attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
    });
    expect(String(r.result!.summary)).toContain('Paris, France');
    const daily = r.result!.daily as Record<string, unknown>[];
    expect(daily).toHaveLength(3);
    expect(daily[0]).toEqual({ date: '2026-10-12', description: 'Partly cloudy', temperatureMin: 12.1, temperatureMax: 20.6, precipitationProbability: 20 });
    expect(JSON.stringify(r.result).length).toBeLessThan(2000);
  });

  it('uses the country to pick the place', async () => {
    expect((await weather({ city: 'Paris, Texas' })).result).toMatchObject({ location: 'Paris, United States' });
  });

  it('takes the number of days from the model, between 1 and 7', async () => {
    const days = async (n: unknown) => ((await weather({ city: 'Lyon', days: n as never })).result!.daily as unknown[]).length;
    expect(await days(5)).toBe(5);
    expect(await days(1)).toBe(1);
    expect(await days(30)).toBe(7);
    expect(await days('2')).toBe(2);
    expect(meteo.forecastRequests().map((q) => q.query.forecast_days)).toEqual(['5', '1', '7', '2']);
  });

  it('uses the units of the node', async () => {
    const r = await weather({ city: 'Paris' }, { temperatureUnit: 'fahrenheit', windSpeedUnit: 'mph' });
    expect(r.result).toMatchObject({ units: { temperature: '°F', windSpeed: 'mp/h' }, current: { temperature: 67.6 } });
    expect(meteo.forecastRequests()[0]!.query).toMatchObject({ temperature_unit: 'fahrenheit', wind_speed_unit: 'mph' });
  });

  it('throws a clear message for an unknown city and for an empty one', async () => {
    expect((await weather({ city: 'Atlantis' })).error).toBe('No place found for "Atlantis"');
    expect((await weather({ city: '' })).error).toMatch(/city is empty/);
    expect(meteo.forecastRequests()).toHaveLength(0);
  });

  it('reports an API that is down without a stack trace', async () => {
    meteo.override.forecast = { status: 500, body: { error: true, reason: 'Internal error' } };
    const down = await weather({ city: 'Paris' });
    expect(down.run.status).toBe('success');
    expect(down.error).toMatch(/Open-Meteo/);
    const port = await closedPort();
    const refused = await call(WEATHER, { options: { forecastUrl: `http://127.0.0.1:${port}/v1/forecast`, geocodingUrl: meteo.geocodingUrl } }, 'get_weather', { city: 'Paris' });
    expect(refused.error).toMatch(/Open-Meteo|Connection refused|could not/i);
  });

  it('is recorded as a run of the tool', async () => {
    const r = await weather({ city: 'Lyon', days: 2 });
    expect(r.run.runData.Tool).toHaveLength(1);
    expect(r.run.runData.Tool![0]).toMatchObject({ status: 'success' });
  });
});

describe('HTTP Request tool', () => {
  const http = (parameters: JsonObject, args: JsonObject, extras: RunnerExtras = {}) =>
    call(HTTP, { method: 'GET', ...parameters }, 'http_request', args, extras);
  const param = (name: string, type = 'string', required = true, description = `The ${name}`) => ({ name, type, required, description });
  const body = (r: { result?: Record<string, unknown> }) => r.result!.body as Record<string, unknown>;

  it('fills a placeholder in the path', async () => {
    const r = await http({ url: `${mock.url}/status/{code}`, toolParameters: { parameter: [param('code', 'number')] } }, { code: 200 });
    expect(r.run.status).toBe('success');
    expect(r.result).toEqual({ status: 200, body: { ok: true, status: 200 } });
    expect(mock.requests[0]!.path).toBe('/status/200');
  });

  it('describes the declared parameters (and the placeholders) to the model', async () => {
    const tool = await describeTool(HTTP, {
      url: `${mock.url}/items/{id}?lang={lang}`,
      toolParameters: { parameter: [param('id', 'number', false, 'The item id'), param('verbose', 'boolean', false, 'More detail')] },
    });
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: { id: { type: 'number', description: 'The item id' }, verbose: { type: 'boolean', description: 'More detail' }, lang: { type: 'string' } },
      // A placeholder is always required, even when declared as optional.
      required: ['id', 'lang'],
    });
  });

  it('encodes placeholder values so they cannot add parameters or leave the path', async () => {
    const r = await http({ url: `${mock.url}/echo?q={q}`, toolParameters: { parameter: [param('q')] } }, { q: 'a b&admin=1#frag/../x' });
    expect(body(r).query).toEqual({ q: 'a b&admin=1#frag/../x' });
    expect(mock.requests[0]!.path).toBe('/echo');
    const dots = await http({ url: `${mock.url}/status/{code}`, toolParameters: { parameter: [param('code')] } }, { code: '..' });
    expect(dots.error).toMatch(/cannot be "\.\."/);
    expect(mock.requests).toHaveLength(1);
  });

  it('sends the other declared parameters in the query string, typed', async () => {
    const r = await http(
      { url: `${mock.url}/echo`, toolParameters: { parameter: [param('city'), param('limit', 'number', false), param('exact', 'boolean', false), param('page', 'number', false)] } },
      { city: 'Paris', limit: '5', exact: true },
    );
    expect(body(r).query).toEqual({ city: 'Paris', limit: '5', exact: 'true' });
    expect(body(r).method).toBe('GET');
  });

  it('sends the parameters as a JSON body with sendIn "body"', async () => {
    const r = await http(
      { method: 'POST', url: `${mock.url}/echo`, sendIn: 'body', toolParameters: { parameter: [param('title'), param('count', 'number'), param('done', 'boolean', false)] } },
      { title: 'Buy milk', count: 3 },
    );
    expect(body(r)).toMatchObject({ method: 'POST', body: { title: 'Buy milk', count: 3 } });
    expect((body(r).headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(body(r).query).toEqual({});
  });

  it('ignores undeclared arguments, whatever the model sends', async () => {
    const r = await http(
      { url: `${mock.url}/echo`, toolParameters: { parameter: [param('q')] } },
      { q: 'x', url: 'http://evil.example/steal', host: 'evil.example', headers: { authorization: 'x' }, admin: 'true' },
    );
    expect(body(r).query).toEqual({ q: 'x' });
    expect((body(r).headers as Record<string, string>).authorization).toBeUndefined();
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.headers.host).toBe(new URL(mock.url).host);
  });

  it('asks for a missing required argument and rejects a wrong type', async () => {
    const parameters = { url: `${mock.url}/echo`, toolParameters: { parameter: [param('q'), param('n', 'number', false)] } };
    expect((await http(parameters, {})).error).toBe('Missing argument "q"');
    expect((await http(parameters, { q: 'a', n: 'many' })).error).toMatch(/"n" must be a number/);
    expect(mock.requests).toHaveLength(0);
  });

  it('never lets a placeholder choose the server: refused when the tool is supplied', async () => {
    for (const url of ['http://{host}/x', `http://127.0.0.1:{port}/x`, '{scheme}://127.0.0.1/x', 'https://api.{domain}/x', 'http://user:{pw}@127.0.0.1/x', '{url}']) {
      const result = await run(cluster('test.aiHarness', { tool: 'http_request', args: { host: 'evil.example' } }, HTTP, { url }));
      expect(result.status, url).toBe('error');
      expect(result.error, url).toMatchObject({ node: 'Tool' });
      expect(result.error?.message, url).toMatch(/not allowed in the host or port|not a valid URL/);
      expect(result.runData.Harness![0]!.status).toBe('error');
    }
    expect(mock.requests).toHaveLength(0);
  });

  it('applies the credential like the HTTP Request node and never shows the secret', async () => {
    const authenticated = await http({ url: `${mock.url}/auth/bearer`, authentication: 'bearerAuth' }, {}, { credentials: bearer() });
    expect(authenticated.result).toEqual({ status: 200, body: { token: 'ok' } });

    // The server echoes the request headers back: the token must be hidden in the answer.
    const echoed = await http({ url: `${mock.url}/echo`, authentication: 'bearerAuth' }, {}, { credentials: bearer() });
    expect((body(echoed).headers as Record<string, string>).authorization).toBe('Bearer ***');
    expect(JSON.stringify(echoed)).not.toContain('tok-12345');
    expect(JSON.stringify(echoed.run.runData)).not.toContain('tok-12345');

    const header = await http({ url: `${mock.url}/auth/header`, authentication: 'headerAuth' }, {}, { credentials: credential('httpHeaderAuth', { name: 'X-API-Key', value: 'key-12345' }) });
    expect(header.result).toMatchObject({ status: 200, body: { key: 'ok' } });
    const basic = await http({ url: `${mock.url}/auth/basic`, authentication: 'basicAuth' }, {}, { credentials: credential('httpBasicAuth', { user: 'ada', password: 's3cret-pw' }) });
    expect(basic.result).toMatchObject({ status: 200, body: { user: 'ada' } });
    const query = await http({ url: `${mock.url}/auth/query`, authentication: 'queryAuth' }, {}, { credentials: credential('httpQueryAuth', { name: 'api_key', value: 'q-12345' }) });
    expect(query.result).toMatchObject({ status: 200, body: { query: 'ok' } });
  });

  it('keeps the secret out of an error, even when the server repeats it', async () => {
    // This mock API answers 401 with the whole URL (including the key) in its message.
    const r = await http(
      { url: `${mock.url}/auth/query`, authentication: 'queryAuth', toolParameters: { parameter: [param('fail')] } },
      { fail: '1' },
      { credentials: credential('httpQueryAuth', { name: 'api_key', value: 'q-12345' }) },
    );
    expect(r.error).toMatch(/401/);
    expect(r.error).toMatch(/invalid request/);
    expect(JSON.stringify(r)).not.toContain('q-12345');
    expect(JSON.stringify(r.run.runData)).not.toContain('q-12345');
    // A wrong token on a credential-protected route: the error names the credential problem, not the token.
    const wrong = await http({ url: `${mock.url}/auth/bearer`, authentication: 'bearerAuth' }, {}, { credentials: bearer('wrong-token-9') });
    expect(wrong.error).toMatch(/401/);
    expect(JSON.stringify(wrong)).not.toContain('wrong-token-9');
  });

  it('reports a missing credential on the tool', async () => {
    const result = await run(cluster('test.aiHarness', { tool: 'http_request' }, HTTP, { url: `${mock.url}/echo`, authentication: 'bearerAuth' }));
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ node: 'Tool' });
  });

  it('turns a 4xx / 5xx into an error with the status and the start of the body', async () => {
    const notFound = await http({ url: `${mock.url}/status/404` }, {});
    expect(notFound.run.status).toBe('success');
    expect(notFound.error).toMatch(/^The server answered 404/);
    expect(notFound.error).toContain('Something specific went wrong');
    expect((await http({ url: `${mock.url}/status/500` }, {})).error).toMatch(/^The server answered 500/);
    expect(notFound.run.runData.Tool![0]).toMatchObject({ status: 'error' });
  });

  it('stops waiting after the timeout option', async () => {
    const started = Date.now();
    const r = await http({ url: `${mock.url}/slow?ms=4000`, options: { timeout: 1 } }, {});
    expect(r.error).toMatch(/No answer from .* within 1 s/);
    expect(Date.now() - started).toBeLessThan(3500);
  });

  it('cuts a long answer at maxResponseChars with a note', async () => {
    const r = await http({ url: `${mock.url}/echo`, options: { maxResponseChars: 100 } }, {});
    const text = r.result!.body as string;
    expect(typeof text).toBe('string');
    expect(text.startsWith('{"method":"GET"')).toBe(true);
    expect(text).toMatch(/\[cut: \d+ more characters not shown\]$/);
    expect(text.split('\n[cut')[0]).toHaveLength(100);
    // A short JSON answer is parsed, text stays text.
    expect((await http({ url: `${mock.url}/text` }, {})).result).toEqual({ status: 200, body: 'plain text ✓' });
  });

  it('sends fixed headers and keeps binary answers out of the context', async () => {
    const r = await http({ url: `${mock.url}/echo`, options: { headers: [{ name: 'X-Source', value: 'flowforge' }] } }, {});
    expect((body(r).headers as Record<string, string>)['x-source']).toBe('flowforge');
    expect((await http({ url: `${mock.url}/file` }, {})).result).toMatchObject({ status: 200, body: expect.stringMatching(/^\[binary content: image\/png, \d+ bytes\]$/) });
  });
});

describe('Code tool', () => {
  const code = (jsCode: string, parameters: JsonObject = {}, args: JsonObject = { query: 'hello big world' }) => call(CODE, { jsCode, ...parameters }, 'run_code', args);
  const declared = (...rows: JsonObject[]) => ({ toolParameters: { parameter: rows } });

  it('runs the default example on the first text argument', async () => {
    const r = await call(CODE, {}, 'run_code', { query: 'hello big world' });
    expect(r.run.status, JSON.stringify(r.run.error)).toBe('success');
    expect(r.result).toEqual({ text: 'hello big world', length: 15, words: 3 });
  });

  it('gives the arguments as `input` and the first text argument as `query`', async () => {
    const r = await code(
      'return { sum: input.a + input.b, upper: query.toUpperCase(), keys: Object.keys(input) };',
      declared({ name: 'text', type: 'string', required: true }, { name: 'a', type: 'number', required: true }, { name: 'b', type: 'number', required: true }),
      { text: 'ada', a: 2, b: 40, extra: 'ignored' },
    );
    expect(r.result).toEqual({ sum: 42, upper: 'ADA', keys: ['text', 'a', 'b'] });
  });

  it('returns objects, lists, text and numbers', async () => {
    expect((await code('return [1, { a: [true, null] }];')).result).toEqual([1, { a: [true, null] }]);
    expect((await code('return "done";')).result).toBe('done');
    expect((await code('return 7 * 6;')).result).toBe(42);
    expect((await code('await Promise.resolve(); return { ok: true };')).result).toEqual({ ok: true });
  });

  it('describes the declared parameters to the model', async () => {
    const tool = await describeTool(CODE, { jsCode: 'return 1;', ...declared({ name: 'amount', type: 'number', required: true, description: 'How much' }, { name: 'note', type: 'string', required: false }) });
    expect(tool.parameters).toEqual({ type: 'object', properties: { amount: { type: 'number', description: 'How much' }, note: { type: 'string' } }, required: ['amount'] });
  });

  it('explains a syntax error, a runtime error and a missing return', async () => {
    expect((await code('return (')).error).toMatch(/SyntaxError/);
    expect((await code('throw new Error("boom");')).error).toMatch(/boom/);
    expect((await code('const x = null; return x.y;')).error).toMatch(/TypeError.*\[line 1\]/);
    expect((await code('const a = 1;')).error).toMatch(/did not return anything/);
    expect((await call(CODE, { jsCode: 'return 1;' }, 'run_code', {})).error).toBe('Missing argument "query"');
    const empty = await run(cluster('test.aiHarness', { tool: 'run_code' }, CODE, { jsCode: '   ' }));
    expect(empty.error).toMatchObject({ node: 'Tool', message: 'The JavaScript code is empty' });
  });

  it('stops an infinite loop with the sandbox time limit', async () => {
    const saved = codeLimits.timeoutMs;
    codeLimits.timeoutMs = 400;
    try {
      const started = Date.now();
      const r = await code('while (true) {}');
      expect(r.error).toMatch(/took longer than 0\.4 s and was stopped/);
      expect(Date.now() - started).toBeLessThan(5000);
      expect((await code('return 1;')).result).toBe(1);
    } finally {
      codeLimits.timeoutMs = saved;
    }
  });

  it('has no process, require, fetch or files', async () => {
    expect((await code('return [typeof process, typeof require, typeof fetch, typeof module, typeof globalThis.process];')).result).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
    const env = await code('return process.env;');
    expect(env.error).toMatch(/ReferenceError: 'process' is not defined/);
    expect(await code('return require("fs").readFileSync("/etc/passwd", "utf8");').then((r) => r.error)).toMatch(/'require' is not defined/);
    expect((await code('return await fetch("http://127.0.0.1:1/");')).error).toMatch(/'fetch' is not defined/);
  });

  it('is recorded as a run of the tool', async () => {
    const r = await code('return 1;');
    expect(r.run.runData.Tool![0]!.data.main[0]![0]!.json).toMatchObject({ tool: 'run_code', input: { query: 'hello big world' }, output: 1 });
  });
});
