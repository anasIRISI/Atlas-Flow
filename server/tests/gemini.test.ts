import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CredentialSummary, JsonObject } from '@flowforge/shared';
import { buildGeminiBody, generateContent, retryTiming } from '../src/integrations/gemini.js';
import { IntegrationError } from '../src/integrations/errors.js';
import { answer, apiError, startGeminiMock, type GeminiMock } from './gemini-mock.js';
import { capturingLogger, makeTestApp, type TestApp } from './helpers.js';
import { PNG } from './http-mock.js';
import { chain, node, signedIn, type Agent } from './trigger-helpers.js';

const KEY = 'AIzaSyTestKey_0123456789abcdefghij';
const TYPE = 'googlePalmApi';

let mock: GeminiMock;
let t: TestApp;
let agent: Agent;
let logger: ReturnType<typeof capturingLogger>;

beforeAll(() => {
  retryTiming.serverErrorBaseMs = 10;
});
beforeEach(async () => {
  mock = await startGeminiMock();
  logger = capturingLogger();
});
afterEach(async () => {
  await t?.close();
  await mock.close();
});

async function start(env: NodeJS.ProcessEnv = {}) {
  t = await makeTestApp({}, { env, logger });
  agent = await signedIn(t);
}

async function saveCredential(data: JsonObject = {}) {
  const res = await agent.post('/api/credentials').send({ name: 'Gemini', type: TYPE, data: { apiKey: KEY, host: mock.url, ...data } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as CredentialSummary;
}

interface RunSummary {
  status: string;
  error?: { message: string; hint?: string; credentialType?: string; credentialId?: string; envVar?: string; docsAnchor?: string };
  nodes: { node: string; status: string; error?: string }[];
  output: JsonObject[][];
}

/** Manual Trigger → Code (one item) [→ Convert to File] → Google Gemini, run through the dev API. */
async function ask(parameters: JsonObject = {}, o: { file?: { mimeType: string; bytes: Buffer }; extra?: JsonObject } = {}): Promise<RunSummary> {
  const nodes = [
    node('Start', 'manualTrigger'),
    node('Items', 'code', { jsCode: `return [{ json: { question: 'Why is the sky blue?', picture: ${JSON.stringify(o.file?.bytes.toString('base64') ?? '')} } }];` }),
  ];
  const names = ['Start', 'Items'];
  if (o.file) {
    nodes.push(node('File', 'convertToFile', { operation: 'base64', sourceProperty: 'picture', binaryPropertyName: 'data', options: { fileName: 'pic', mimeType: o.file.mimeType } }));
    names.push('File');
  }
  nodes.push(node('Gemini', 'googleGemini', { prompt: 'Say hello', ...parameters }, o.extra));
  names.push('Gemini');
  const res = await agent.post('/api/dev/run').send({ name: 'Gemini', nodes, connections: chain(...names) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as RunSummary;
}

describe('Google Gemini node: requests', () => {
  it('returns the text of the answer with model, finish reason and usage', async () => {
    await start();
    await saveCredential();
    mock.enqueue(answer('Because of Rayleigh scattering.', { modelVersion: 'gemini-3.8-flash', usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5, thoughtsTokenCount: 20, totalTokenCount: 36 } }));
    const run = await ask({ prompt: '={{ $("Items").item.json.question }}' });
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(run.output[0]![0]).toEqual({
      text: 'Because of Rayleigh scattering.',
      model: 'gemini-3.8-flash',
      finishReason: 'STOP',
      usage: { promptTokens: 11, outputTokens: 5, thoughtsTokens: 20, totalTokens: 36 },
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.method).toBe('POST');
    expect(mock.calls[0]!.url).toBe('/v1beta/models/gemini-3.8-flash:generateContent');
    expect(mock.calls[0]!.body).toEqual({ contents: [{ role: 'user', parts: [{ text: 'Why is the sky blue?' }] }] });
  });

  it('sends the key only in the x-goog-api-key header, never in the URL', async () => {
    await start();
    await saveCredential();
    await ask();
    const call = mock.calls[0]!;
    expect(call.headers['x-goog-api-key']).toBe(KEY);
    expect(call.headers['content-type']).toContain('application/json');
    expect(call.url).not.toMatch(/key=/i);
    expect(call.url).not.toContain(KEY);
    expect(call.url.includes('?')).toBe(false);
    expect(call.raw).not.toContain(KEY);
  });

  it('maps the system instruction and the options to systemInstruction / generationConfig', async () => {
    await start();
    await saveCredential();
    await ask({ systemInstruction: 'You are a pirate.', options: { temperature: 0.2, maxOutputTokens: 100, topP: 0.5, topK: 10 } });
    expect(mock.calls[0]!.body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Say hello' }] }],
      systemInstruction: { parts: [{ text: 'You are a pirate.' }] },
      generationConfig: { temperature: 0.2, maxOutputTokens: 100, topP: 0.5, topK: 10 },
    });
  });

  it('JSON mode: responseMimeType and the parsed object in json', async () => {
    await start();
    await saveCredential();
    mock.enqueue(answer('{"city":"Rabat","temp":21}'));
    const run = await ask({ jsonOutput: true });
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(mock.calls[0]!.body.generationConfig).toEqual({ responseMimeType: 'application/json' });
    expect(run.output[0]![0]).toMatchObject({ text: '{"city":"Rabat","temp":21}', json: { city: 'Rabat', temp: 21 } });
  });

  it('JSON mode: strips a ```json fence', async () => {
    await start();
    await saveCredential();
    mock.enqueue(answer('```json\n{"ok":true,"list":[1,2]}\n```'));
    const run = await ask({ jsonOutput: true });
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(run.output[0]![0]!.json).toEqual({ ok: true, list: [1, 2] });
  });

  it('JSON mode: invalid JSON is a clear error with the start of the answer', async () => {
    await start();
    await saveCredential();
    mock.enqueue(answer('Sure! Here is your data: {oops'));
    const run = await ask({ jsonOutput: true });
    expect(run.status).toBe('error');
    expect(run.error!.message).toBe('Gemini did not return valid JSON');
    expect(run.error!.hint).toContain('Sure! Here is your data');
  });

  it('skips thought parts and joins the others', async () => {
    await start();
    await saveCredential();
    mock.enqueue({ body: { candidates: [{ content: { parts: [{ text: 'I should be brief.', thought: true }, { text: 'Hel' }, { text: 'lo' }] }, finishReason: 'STOP' }] } });
    const run = await ask();
    expect(run.output[0]![0]).toMatchObject({ text: 'Hello', usage: { promptTokens: 0, outputTokens: 0, thoughtsTokens: 0, totalTokens: 0 } });
  });

  it('MAX_TOKENS with some text still returns it', async () => {
    await start();
    await saveCredential();
    mock.enqueue({ body: { candidates: [{ content: { parts: [{ text: 'Half an answ' }] }, finishReason: 'MAX_TOKENS' }] } });
    const run = await ask();
    expect(run.output[0]![0]).toMatchObject({ text: 'Half an answ', finishReason: 'MAX_TOKENS' });
  });
});

describe('Google Gemini node: images', () => {
  it('sends an image binary as inlineData (mime type + base64 of the file)', async () => {
    await start();
    await saveCredential();
    const run = await ask({ sendImages: true, binaryPropertyName: 'data' }, { file: { mimeType: 'image/png', bytes: PNG } });
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    const parts = mock.calls[0]!.body.contents[0].parts;
    expect(parts).toEqual([{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }, { text: 'Say hello' }]);
    expect(Buffer.from(parts[0].inlineData.data, 'base64').equals(PNG)).toBe(true);
  });

  it('refuses a non-image file and names its mime type, without calling Gemini', async () => {
    await start();
    await saveCredential();
    const run = await ask({ sendImages: true }, { file: { mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 test') } });
    expect(run.status).toBe('error');
    expect(run.error!.message).toContain('application/pdf');
    expect(mock.calls).toHaveLength(0);
  });

  it('an item without the binary property gets a clear error', async () => {
    await start();
    await saveCredential();
    const run = await ask({ sendImages: true, binaryPropertyName: 'photo' });
    expect(run.status).toBe('error');
    expect(run.error!.message).toContain('"photo"');
    expect(mock.calls).toHaveLength(0);
  });

  it('the client refuses more than 15 MB of images before any call', async () => {
    const big = { mimeType: 'image/png', data: Buffer.alloc(8 * 1024 * 1024) };
    await expect(generateContent({ apiKey: KEY, host: mock.url }, { model: 'gemini-3.8-flash', prompt: 'x', images: [big, big] })).rejects.toThrow(/too big/);
    await expect(generateContent({ apiKey: KEY, host: mock.url }, { model: 'gemini-3.8-flash', prompt: 'x', images: [{ mimeType: 'text/plain', data: Buffer.from('a') }] })).rejects.toThrow(/text\/plain/);
    expect(mock.calls).toHaveLength(0);
  });
});

describe('Google Gemini node: model', () => {
  it('Default uses the model of the credential', async () => {
    await start();
    await saveCredential({ model: 'gemini-3.5-flash-lite' });
    await ask();
    expect(mock.calls[0]!.model).toBe('gemini-3.5-flash-lite');
  });

  it('Default without a credential model uses gemini-3.8-flash', async () => {
    await start();
    await saveCredential();
    await ask();
    expect(mock.calls[0]!.model).toBe('gemini-3.8-flash');
  });

  it('Default from .env uses GEMINI_MODEL (and the .env key and host)', async () => {
    await start({ GEMINI_API_KEY: KEY, GEMINI_API_URL: mock.url, GEMINI_MODEL: 'gemini-3.6-flash' });
    const run = await ask();
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(mock.calls[0]!.model).toBe('gemini-3.6-flash');
    expect(mock.calls[0]!.headers['x-goog-api-key']).toBe(KEY);
  });

  it('a listed model overrides the credential', async () => {
    await start();
    await saveCredential({ model: 'gemini-3.5-flash-lite' });
    await ask({ model: 'gemini-3.1-flash-lite' });
    expect(mock.calls[0]!.model).toBe('gemini-3.1-flash-lite');
  });

  it('Custom uses customModel; an empty one is an error before the call', async () => {
    await start();
    await saveCredential();
    await ask({ model: 'custom', customModel: 'my-tuned-model' });
    expect(mock.calls[0]!.model).toBe('my-tuned-model');
    const run = await ask({ model: 'custom', customModel: '' });
    expect(run.status).toBe('error');
    expect(run.error!.message).toContain('custom model');
    expect(mock.calls).toHaveLength(1);
  });

  it('an empty prompt is an error before the call', async () => {
    await start();
    await saveCredential();
    const run = await ask({ prompt: '   ' });
    expect(run.status).toBe('error');
    expect(run.error!.message).toBe('The prompt is empty');
    expect(run.error!.hint).toBeTruthy();
    expect(mock.calls).toHaveLength(0);
  });
});

describe('Gemini client: conversation history', () => {
  it('builds contents from history, then the prompt (with images before the text)', () => {
    const body = buildGeminiBody({
      model: 'm',
      prompt: 'And in French?',
      history: [
        { role: 'user', text: 'Say hi' },
        { role: 'model', text: 'Hi!' },
      ],
      images: [{ mimeType: 'image/png', data: PNG }],
    });
    expect(body).toEqual({
      contents: [
        { role: 'user', parts: [{ text: 'Say hi' }] },
        { role: 'model', parts: [{ text: 'Hi!' }] },
        { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }, { text: 'And in French?' }] },
      ],
    });
  });

  it('sends the history to the API', async () => {
    const result = await generateContent({ apiKey: KEY, host: mock.url }, { model: 'gemini-3.8-flash', prompt: 'Next', history: [{ role: 'user', text: 'First' }, { role: 'model', text: 'Reply' }] });
    expect(result.text).toBe('Hello from Gemini');
    expect(mock.calls[0]!.body.contents.map((c: { role: string; parts: { text: string }[] }) => [c.role, c.parts[0]!.text])).toEqual([
      ['user', 'First'],
      ['model', 'Reply'],
      ['user', 'Next'],
    ]);
  });
});

describe('Google Gemini node: errors', () => {
  it('400 invalid key: CredentialError for the saved credential', async () => {
    await start();
    const cred = await saveCredential();
    mock.enqueue(apiError(400, 'API key not valid. Please pass a valid API key.', [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }], 'INVALID_ARGUMENT'));
    const run = await ask();
    expect(run.status).toBe('error');
    expect(run.error).toMatchObject({ message: 'The Gemini API key is not valid', credentialType: TYPE, credentialId: cred.id });
    expect(run.error!.hint).not.toContain('.env');
    expect(mock.calls).toHaveLength(1);
  });

  it('400 invalid key from .env: the hint names GEMINI_API_KEY', async () => {
    await start({ GEMINI_API_KEY: KEY, GEMINI_API_URL: mock.url });
    // The newer documented shape: a string code, no details.
    mock.enqueue({ status: 400, body: { error: { code: 'invalid_request', message: 'API key not valid. Please pass a valid API key.' } } });
    const run = await ask();
    expect(run.status).toBe('error');
    expect(run.error!.credentialType).toBe(TYPE);
    expect(run.error!.credentialId).toBeUndefined();
    expect(run.error!.hint).toContain('.env (GEMINI_API_KEY)');
  });

  it('400 other: the API message and a hint, not a credential error', async () => {
    await start();
    await saveCredential();
    mock.enqueue(apiError(400, 'Invalid value at generation_config.temperature', [], 'INVALID_ARGUMENT'));
    const run = await ask();
    expect(run.status).toBe('error');
    expect(run.error!.message).toContain('Invalid value at generation_config.temperature');
    expect(run.error!.credentialType).toBeUndefined();
    expect(run.error!.hint).toContain('gemini-3.8-flash');
  });

  it('403: the key is missing a permission (credential error)', async () => {
    await start();
    const cred = await saveCredential();
    mock.enqueue(apiError(403, 'Generative Language API has not been used in project 123 before.', [], 'PERMISSION_DENIED'));
    const run = await ask();
    expect(run.error).toMatchObject({ credentialType: TYPE, credentialId: cred.id });
    expect(run.error!.message).toContain('missing a permission');
    expect(run.error!.message).toContain('has not been used in project 123');
  });

  it('404: the model does not exist, with the model list', async () => {
    await start();
    await saveCredential();
    mock.enqueue(apiError(404, 'models/nope is not found', [], 'NOT_FOUND'));
    const run = await ask({ model: 'custom', customModel: 'nope' });
    expect(run.status).toBe('error');
    expect(run.error!.message).toBe('The model "nope" does not exist');
    expect(run.error!.hint).toContain('gemini-3.8-flash');
    expect(run.error!.hint).toContain('gemini-3.1-flash-lite');
  });

  it('429 with a short wait is retried, then succeeds', async () => {
    await start();
    await saveCredential();
    mock.enqueue(apiError(429, 'Quota exceeded', [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.05s' }], 'RESOURCE_EXHAUSTED'), answer('Finally'));
    const run = await ask();
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(run.output[0]![0]!.text).toBe('Finally');
    expect(mock.calls).toHaveLength(2);
  });

  it('429 retries stop after maxRetries', async () => {
    await start();
    await saveCredential();
    const busy = apiError(429, 'Quota exceeded', [{ retryDelay: '0.01s' }], 'RESOURCE_EXHAUSTED');
    mock.enqueue(busy, busy, busy, busy);
    const run = await ask({ options: { maxRetries: 1 } });
    expect(run.status).toBe('error');
    expect(run.error!.message).toContain('rate limit');
    expect(mock.calls).toHaveLength(2);
  });

  it('429 with a long wait is not retried and says how long to wait', async () => {
    await start();
    await saveCredential();
    mock.enqueue(apiError(429, 'Quota exceeded', [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' }], 'RESOURCE_EXHAUSTED'));
    const run = await ask();
    expect(run.status).toBe('error');
    expect(run.error!.message).toContain('rate limit');
    expect(run.error!.message).toContain('42 s');
    expect(run.error!.hint).toContain('42 s');
    expect(mock.calls).toHaveLength(1);
  });

  it('a retry wait can be aborted', async () => {
    mock.enqueue(apiError(429, 'Quota exceeded', [{ retryDelay: '10s' }], 'RESOURCE_EXHAUSTED'));
    const controller = new AbortController();
    const started = Date.now();
    const pending = generateContent({ apiKey: KEY, host: mock.url }, { model: 'gemini-3.8-flash', prompt: 'x' }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('canceled')), 150);
    await expect(pending).rejects.toThrow('canceled');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(mock.calls).toHaveLength(1);
  });

  it('503 is retried, then succeeds', async () => {
    await start();
    await saveCredential();
    mock.enqueue(apiError(503, 'The model is overloaded.', [], 'UNAVAILABLE'), apiError(500, 'Internal error', [], 'INTERNAL'), answer('Back'));
    const run = await ask();
    expect(run.status, JSON.stringify(run.error)).toBe('success');
    expect(run.output[0]![0]!.text).toBe('Back');
    expect(mock.calls).toHaveLength(3);
  });

  it('503 forever: error after maxRetries', async () => {
    await start();
    await saveCredential();
    const down = apiError(503, 'The model is overloaded.', [], 'UNAVAILABLE');
    mock.enqueue(down, down, down, down);
    const run = await ask();
    expect(run.status).toBe('error');
    expect(run.error!.message).toContain('unavailable');
    expect(mock.calls).toHaveLength(3);
  });

  it('prompt blocked by promptFeedback', async () => {
    await start();
    await saveCredential();
    mock.enqueue({ body: { promptFeedback: { blockReason: 'SAFETY' } } });
    const run = await ask();
    expect(run.status).toBe('error');
    expect(run.error!.message).toBe('Gemini blocked the prompt (SAFETY)');
  });

  it('finishReason SAFETY without text', async () => {
    await start();
    await saveCredential();
    mock.enqueue({ body: { candidates: [{ finishReason: 'SAFETY' }] } });
    const run = await ask();
    expect(run.status).toBe('error');
    expect(run.error!.message).toBe('Gemini stopped the answer (SAFETY)');
  });

  it('MAX_TOKENS without text: hint to raise Max Output Tokens', async () => {
    await start();
    await saveCredential();
    mock.enqueue({ body: { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }] }, finishReason: 'MAX_TOKENS' }] } });
    const run = await ask({ options: { maxOutputTokens: 5 } });
    expect(run.status).toBe('error');
    expect(run.error!.hint).toContain('Max Output Tokens');
  });

  it('a malformed (non-JSON) answer is a clear error', async () => {
    await start();
    await saveCredential();
    mock.enqueue({ raw: '<html>Bad gateway</html>' });
    const run = await ask();
    expect(run.status).toBe('error');
    expect(run.error!.message).toBe('Gemini answered something that is not JSON');
    expect(run.error!.hint).toContain('Bad gateway');
  });

  it('a timeout is a clear error', async () => {
    mock.enqueue({ delayMs: 1500, ...answer('too late') });
    const error = await generateContent({ apiKey: KEY, host: mock.url }, { model: 'gemini-3.8-flash', prompt: 'x' }, { timeoutMs: 150 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/No answer from 127\.0\.0\.1/);
  });

  it('missing credential: the error carries the type and GEMINI_API_KEY', async () => {
    await start();
    const run = await ask();
    expect(run.status).toBe('error');
    expect(run.error).toMatchObject({ credentialType: TYPE, envVar: 'GEMINI_API_KEY' });
    expect(run.error!.hint).toContain('GEMINI_API_KEY');
    expect(mock.calls).toHaveLength(0);
  });
});

describe('Google Gemini credential', () => {
  it('Test button: a tiny prompt on the credential model, no retries', async () => {
    await start();
    const ok = await agent.post('/api/credentials/test').send({ type: TYPE, data: { apiKey: KEY, host: mock.url } });
    expect(ok.body).toMatchObject({ ok: true, message: 'The key works (model gemini-3.8-flash answered).' });
    expect(mock.calls[0]!.body).toEqual({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }] });
    expect(mock.calls[0]!.headers['x-goog-api-key']).toBe(KEY);

    const other = await agent.post('/api/credentials/test').send({ type: TYPE, data: { apiKey: KEY, host: mock.url, model: 'gemini-3.5-flash-lite' } });
    expect(other.body.message).toBe('The key works (model gemini-3.5-flash-lite answered).');
    expect(mock.calls[1]!.model).toBe('gemini-3.5-flash-lite');
  });

  it('Test button: a wrong key or a busy API gives ok:false with a hint, never an exception', async () => {
    await start();
    mock.enqueue(apiError(400, 'API key not valid. Please pass a valid API key.', [{ reason: 'API_KEY_INVALID' }], 'INVALID_ARGUMENT'), apiError(503, 'Overloaded', [], 'UNAVAILABLE'));
    const wrong = await agent.post('/api/credentials/test').send({ type: TYPE, data: { apiKey: 'AIzaSyWrongKey000000', host: mock.url } });
    expect(wrong.status).toBe(200);
    expect(wrong.body).toMatchObject({ ok: false, message: 'The Gemini API key is not valid' });
    expect(wrong.body.hint).toContain('aistudio.google.com');
    const busy = await agent.post('/api/credentials/test').send({ type: TYPE, data: { apiKey: KEY, host: mock.url } });
    expect(busy.body).toMatchObject({ ok: false });
    expect(mock.calls).toHaveLength(2);
  });

  it('Test button on a saved credential reuses the stored key', async () => {
    await start();
    const cred = await saveCredential();
    const res = await agent.post('/api/credentials/test').send({ type: TYPE, id: cred.id, data: { apiKey: '', host: mock.url } });
    expect(res.body.ok).toBe(true);
    expect(mock.calls[0]!.headers['x-goog-api-key']).toBe(KEY);
  });
});

describe('secrets never leak', () => {
  it('the API key is absent from run results, errors, hints and captured logs', async () => {
    await start();
    await saveCredential();
    // The server echoes the key in its error text: it must come out redacted.
    mock.enqueue(apiError(400, `Invalid argument for key ${KEY}`, [], 'INVALID_ARGUMENT'), { raw: `oops ${KEY}` });
    const failed = await ask();
    const malformed = await ask();
    const ok = await ask();
    expect(failed.status).toBe('error');
    expect(failed.error!.message).toContain('***');
    expect(malformed.error!.hint).toContain('***');
    expect(ok.status).toBe('success');
    const detail = await agent.get('/api/executions');
    for (const body of [failed, malformed, ok, detail.body]) expect(JSON.stringify(body)).not.toContain(KEY);
    expect(logger.lines.join('\n')).not.toContain(KEY);
  });

  it('a network failure does not show the key either', async () => {
    const error = await generateContent({ apiKey: KEY, host: 'http://127.0.0.1:1' }, { model: 'gemini-3.8-flash', prompt: 'x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(IntegrationError);
    expect(JSON.stringify([(error as Error).message, (error as { hint?: string }).hint])).not.toContain(KEY);
  });
});
