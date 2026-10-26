// Google Gemini client (plain HTTP, no Google SDK).
//
// Official docs:
//   generateContent  https://ai.google.dev/api/generate-content
//   models           https://ai.google.dev/gemini-api/docs/models
//   API key          https://ai.google.dev/gemini-api/docs/api-key
//   troubleshooting  https://ai.google.dev/gemini-api/docs/troubleshooting
//
// POST {host}/v1beta/models/{model}:generateContent with the key ONLY in the `x-goog-api-key` header
// (never the `?key=` query, it would end up in logs and error messages).
import { httpSend, redact } from '../nodes/_shared/http-client.js';
import { IntegrationError } from './errors.js';

export const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
export const GEMINI_DEFAULT_MODEL = 'gemini-3.8-flash';
/** Models with a free tier (2026-10). The first one is the default. */
export const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] as const;
/** Total size of the inline images of one request (the API limit for inline data is about 20 MB with the prompt). */
export const MAX_INLINE_BYTES = 15 * 1024 * 1024;
/** A 429 asking to wait longer than this is not retried: the error tells how long to wait instead. */
export const MAX_RETRY_WAIT_MS = 15_000;
/** Tests shorten the 1 s / 2 s pause before a 500 / 503 is retried. */
export const retryTiming = { serverErrorBaseMs: 1000 };

const SERVICE = 'Gemini';
const MODEL_LIST = GEMINI_MODELS.join(', ');

export interface GeminiAuth {
  apiKey: string;
  host?: string;
}

export interface GeminiHistoryMessage {
  role: 'user' | 'model';
  text: string;
}

export interface GeminiImage {
  mimeType: string;
  data: Buffer;
}

export interface GeminiRequest {
  model: string;
  prompt: string;
  /** Earlier messages of the conversation (memory), oldest first. */
  history?: GeminiHistoryMessage[];
  systemInstruction?: string;
  images?: GeminiImage[];
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  /** Asks for a JSON answer and parses it into `json`. */
  json?: boolean;
  /** Retries of a 429 (short wait) or 500 / 503. Default 2. */
  maxRetries?: number;
}

export interface GeminiResult {
  text: string;
  json?: unknown;
  model: string;
  finishReason: string;
  usage: { promptTokens: number; outputTokens: number; thoughtsTokens: number; totalTokens: number };
}

export interface GeminiCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The request body of generateContent: only fields of the official API, unset generation settings are left out. */
export function buildGeminiBody(request: GeminiRequest): Obj {
  const userParts: Obj[] = [];
  for (const image of request.images ?? []) userParts.push({ inlineData: { mimeType: image.mimeType, data: image.data.toString('base64') } });
  userParts.push({ text: request.prompt });
  const contents: Obj[] = [
    ...(request.history ?? []).filter((m) => m.text.trim() !== '').map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    { role: 'user', parts: userParts },
  ];
  const body: Obj = { contents };
  if (request.systemInstruction?.trim()) body.systemInstruction = { parts: [{ text: request.systemInstruction }] };
  const generationConfig: Obj = {};
  const settings: [string, number | undefined][] = [
    ['temperature', num(request.temperature)],
    ['maxOutputTokens', num(request.maxOutputTokens)],
    ['topP', num(request.topP)],
    ['topK', num(request.topK)],
  ];
  for (const [key, value] of settings) if (value !== undefined) generationConfig[key] = value;
  if (request.json) generationConfig.responseMimeType = 'application/json';
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  return body;
}

/** Refuses non-image files and requests that are too big, before any network call. */
export function checkImages(images: GeminiImage[]): void {
  let total = 0;
  for (const image of images) {
    if (!/^image\//i.test(image.mimeType)) {
      throw new IntegrationError(SERVICE, `Gemini cannot read a file of type "${image.mimeType || 'unknown'}" here`, { hint: 'Only images (image/png, image/jpeg, image/webp…) can be sent.' });
    }
    total += image.data.byteLength;
  }
  if (total > MAX_INLINE_BYTES) {
    throw new IntegrationError(SERVICE, `The images are too big to send (${(total / 1024 / 1024).toFixed(1)} MB, the limit is ${MAX_INLINE_BYTES / 1024 / 1024} MB)`, {
      hint: 'Send fewer or smaller images (resize them first).',
    });
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** "12s" / "0.5s" / "12.345678s" → ms. */
function parseDelay(value: unknown): number | undefined {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(typeof value === 'string' ? value.trim() : '');
  return match ? Math.ceil(Number(match[1]) * 1000) : undefined;
}

const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text);

interface ApiProblem {
  message: string;
  /** Machine-readable reason: details[].reason, else the string code / status. */
  code?: string;
  retryAfterMs?: number;
}

/** Both error shapes: `{ code: 400, status: "INVALID_ARGUMENT", details }` and `{ code: "invalid_request" }`. */
function readProblem(body: string, secrets: string[]): ApiProblem {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { message: redact(clip(body.trim()), secrets) };
  }
  const error = isObj(parsed) && isObj(parsed.error) ? parsed.error : undefined;
  if (!error) return { message: redact(clip(body.trim()), secrets) };
  const details = Array.isArray(error.details) ? error.details.filter(isObj) : [];
  const reason = details.map((d) => d.reason).find((r): r is string => typeof r === 'string');
  const retryAfterMs = details.map((d) => parseDelay(d.retryDelay)).find((d) => d !== undefined);
  const code = reason ?? (typeof error.code === 'string' ? error.code : typeof error.status === 'string' ? error.status : undefined);
  return { message: redact(typeof error.message === 'string' ? clip(error.message.trim()) : '', secrets), code, retryAfterMs };
}

function apiError(status: number, problem: ApiProblem, model: string): IntegrationError {
  const api = problem.message ? `: ${problem.message}` : '';
  const info = { status, code: problem.code, retryAfterMs: problem.retryAfterMs };
  if (status === 400 && (problem.code === 'API_KEY_INVALID' || /API key not valid/i.test(problem.message))) {
    return new IntegrationError(SERVICE, 'The Gemini API key is not valid', { ...info, auth: true, hint: 'Create a new key at aistudio.google.com/apikey and paste it in the Google Gemini API credential.' });
  }
  if (status === 400) {
    return new IntegrationError(SERVICE, `Gemini did not accept the request${api}`, { ...info, hint: `Check the model name (${MODEL_LIST}) and the settings (temperature, top P, top K, max output tokens).` });
  }
  if (status === 401 || status === 403) {
    return new IntegrationError(SERVICE, `The Gemini API key is missing a permission${api}`, {
      ...info,
      auth: true,
      hint: 'Check that the key belongs to a project where the Generative Language API is enabled, and that your country and the model allow its use.',
    });
  }
  if (status === 404) {
    return new IntegrationError(SERVICE, `The model "${model}" does not exist`, { ...info, hint: `Models with a free tier: ${MODEL_LIST}. Pick one of them, or fix the custom model name.` });
  }
  if (status === 429) {
    const wait = problem.retryAfterMs !== undefined ? ` Wait about ${Math.max(1, Math.ceil(problem.retryAfterMs / 1000))} s before the next try.` : ' Wait a minute before the next try.';
    return new IntegrationError(SERVICE, `Gemini rate limit reached${problem.retryAfterMs !== undefined ? ` (wait about ${Math.max(1, Math.ceil(problem.retryAfterMs / 1000))} s)` : ''}`, {
      ...info,
      hint: `The free tier limits requests per minute and per day for the whole project (see AI Studio).${wait} A lighter model such as gemini-3.5-flash-lite may help.`,
    });
  }
  if (status >= 500) {
    return new IntegrationError(SERVICE, `Gemini is unavailable right now (${status})${api}`, { ...info, hint: 'The problem is on Google\'s side. Try again in a moment, or choose another model.' });
  }
  return new IntegrationError(SERVICE, `Gemini answered ${status}${api}`, info);
}

const STOPPED_BY_SAFETY = 'The answer was cut by a safety filter. Reword the prompt or the input.';

/** JSON-parses an answer body and refuses a blocked prompt. Shared by `generateContent` and `generateTurn`. */
function parseBody(body: string, secrets: string[]): Obj {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new IntegrationError(SERVICE, 'Gemini answered something that is not JSON', { hint: `Start of the answer: ${redact(clip(body.trim(), 200), secrets)}` });
  }
  if (!isObj(parsed)) throw new IntegrationError(SERVICE, 'Gemini answered something unexpected', { hint: 'Try again in a moment.' });

  const blockReason = isObj(parsed.promptFeedback) && typeof parsed.promptFeedback.blockReason === 'string' ? parsed.promptFeedback.blockReason : undefined;
  if (blockReason) {
    throw new IntegrationError(SERVICE, `Gemini blocked the prompt (${blockReason})`, { code: blockReason, hint: 'The prompt or an image was refused by the safety filters. Reword it and try again.' });
  }
  return parsed;
}

/** Finish reasons that mean the model failed to call a tool (documented values of `candidates[].finishReason`). */
const TOOL_FINISH_REASONS = ['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS', 'MISSING_THOUGHT_SIGNATURE'];

/** The error for an answer with no text (and, for a turn, no function call either). */
function noTextError(finishReason: string): IntegrationError {
  if (finishReason === 'MAX_TOKENS') {
    return new IntegrationError(SERVICE, 'Gemini used all its output tokens before writing an answer', {
      code: finishReason,
      hint: 'Raise "Max Output Tokens" in the options (the thinking tokens count too), or leave it empty.',
    });
  }
  if (TOOL_FINISH_REASONS.includes(finishReason)) {
    return new IntegrationError(SERVICE, `Gemini could not call the tool (${finishReason})`, {
      code: finishReason,
      hint: 'The model produced a tool call it could not complete. Try again, simplify the tool descriptions, or choose another model.',
    });
  }
  if (finishReason !== 'STOP' && finishReason !== 'UNKNOWN') {
    return new IntegrationError(SERVICE, `Gemini stopped the answer (${finishReason})`, { code: finishReason, hint: STOPPED_BY_SAFETY });
  }
  return new IntegrationError(SERVICE, 'Gemini returned an empty answer', { hint: 'Try again, or make the prompt more precise.' });
}

function usageOf(parsed: Obj) {
  const usageMetadata = isObj(parsed.usageMetadata) ? parsed.usageMetadata : {};
  return {
    promptTokens: num(usageMetadata.promptTokenCount) ?? 0,
    outputTokens: num(usageMetadata.candidatesTokenCount) ?? 0,
    thoughtsTokens: num(usageMetadata.thoughtsTokenCount) ?? 0,
    totalTokens: num(usageMetadata.totalTokenCount) ?? 0,
  };
}

function readAnswer(body: string, request: GeminiRequest, secrets: string[]): GeminiResult {
  const parsed = parseBody(body, secrets);

  const candidate = Array.isArray(parsed.candidates) ? parsed.candidates.find(isObj) : undefined;
  const parts = candidate && isObj(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts.filter(isObj) : [];
  // Thought summaries are not part of the answer.
  const text = parts
    .filter((p) => p.thought !== true && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
  const finishReason = candidate && typeof candidate.finishReason === 'string' ? candidate.finishReason : text ? 'STOP' : 'UNKNOWN';

  if (!text) throw noTextError(finishReason);

  const result: GeminiResult = {
    text,
    model: typeof parsed.modelVersion === 'string' && parsed.modelVersion ? parsed.modelVersion : request.model,
    finishReason,
    usage: usageOf(parsed),
  };
  if (request.json) result.json = parseJsonAnswer(text, secrets);
  return result;
}

/** JSON mode: the model sometimes wraps the JSON in a ```json fence. */
function parseJsonAnswer(text: string, secrets: string[]): unknown {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  try {
    return JSON.parse((fenced ? fenced[1]! : text).trim());
  } catch {
    throw new IntegrationError(SERVICE, 'Gemini did not return valid JSON', {
      hint: `Start of the answer: ${redact(clip(text.trim(), 200), secrets)}. Ask for JSON explicitly in the prompt and describe the fields you expect, or turn JSON Mode off.`,
    });
  }
}

/** POST to generateContent with the retry policy (429 with a short wait, 500, 503). Returns the body of a 2xx answer. */
async function postGenerate(auth: GeminiAuth, modelName: string, body: Obj, requestedRetries: number | undefined, o: GeminiCallOptions): Promise<{ text: string; model: string; secrets: string[] }> {
  const apiKey = auth.apiKey.trim();
  const secrets = [apiKey];
  const model = modelName.trim().replace(/^models\//, '');
  const url = `${(auth.host?.trim() || GEMINI_HOST).replace(/\/+$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const payload = JSON.stringify(body);
  const maxRetries = Math.min(Math.max(Math.floor(requestedRetries ?? 2), 0), 5);
  const signal = o.signal ?? new AbortController().signal;

  for (let attempt = 0; ; attempt++) {
    const res = await httpSend({
      method: 'POST',
      url,
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: payload,
      timeoutMs: o.timeoutMs ?? 60_000,
      followRedirects: false,
      maxRedirects: 0,
      ignoreSsl: false,
      signal,
      secrets,
    });
    const text = res.body.toString('utf8');
    if (res.statusCode >= 200 && res.statusCode < 300) return { text, model, secrets };

    const error = apiError(res.statusCode, readProblem(text, secrets), model);
    if (attempt < maxRetries) {
      if (res.statusCode === 429 && (error.retryAfterMs ?? 0) <= MAX_RETRY_WAIT_MS) {
        await sleep(error.retryAfterMs ?? retryTiming.serverErrorBaseMs * 2 ** attempt, signal);
        continue;
      }
      if (res.statusCode === 500 || res.statusCode === 503) {
        await sleep(retryTiming.serverErrorBaseMs * 2 ** attempt, signal);
        continue;
      }
    }
    throw error;
  }
}

/** One prompt → one answer. Retries 429 (short waits) and 500 / 503; every other failure throws an IntegrationError. */
export async function generateContent(auth: GeminiAuth, request: GeminiRequest, o: GeminiCallOptions = {}): Promise<GeminiResult> {
  checkImages(request.images ?? []);
  const sent = await postGenerate(auth, request.model, buildGeminiBody(request), request.maxRetries, o);
  return readAnswer(sent.text, { ...request, model: sent.model }, sent.secrets);
}

// ── Function calling (AI Agent) ──────────────────────────────────────────────
// Docs: https://ai.google.dev/api/generate-content (tools, toolConfig.functionCallingConfig, Content, Part)

/** One entry of `tools[].functionDeclarations`. */
export interface GeminiFunctionDeclaration {
  /** a-z, A-Z, 0-9 and underscores, at most 128 characters. */
  name: string;
  description: string;
  /** A JSON Schema object. */
  parametersJsonSchema: Record<string, unknown>;
}

export interface GeminiTurnRequest {
  model: string;
  /** Gemini `Content[]`, sent as is (model contents of earlier turns must be the raw ones, thought signatures included). */
  contents: unknown[];
  systemInstruction?: string;
  tools?: GeminiFunctionDeclaration[];
  /** "none" = `toolConfig.functionCallingConfig.mode: "NONE"` (the model must answer with text). Default: nothing sent (AUTO). */
  toolChoice?: 'auto' | 'none';
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  maxRetries?: number;
}

export interface GeminiFunctionCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiTurnResult {
  /** `candidates[0].content` exactly as received: put it back unchanged in the next request. */
  content: unknown;
  text: string;
  functionCalls: GeminiFunctionCall[];
  finishReason: string;
  model: string;
  usage: GeminiResult['usage'];
}

export function buildTurnBody(request: GeminiTurnRequest): Obj {
  const body: Obj = { contents: request.contents };
  if (request.systemInstruction?.trim()) body.systemInstruction = { parts: [{ text: request.systemInstruction }] };
  const tools = request.tools ?? [];
  if (tools.length) {
    body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parametersJsonSchema })) }];
    if (request.toolChoice === 'none') body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
  }
  const generationConfig: Obj = {};
  const settings: [string, number | undefined][] = [
    ['temperature', num(request.temperature)],
    ['maxOutputTokens', num(request.maxOutputTokens)],
    ['topP', num(request.topP)],
    ['topK', num(request.topK)],
  ];
  for (const [key, value] of settings) if (value !== undefined) generationConfig[key] = value;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  return body;
}

function readTurn(body: string, modelName: string, secrets: string[]): GeminiTurnResult {
  const parsed = parseBody(body, secrets);
  const candidate = Array.isArray(parsed.candidates) ? parsed.candidates.find(isObj) : undefined;
  const content = candidate && isObj(candidate.content) ? candidate.content : undefined;
  const parts = content && Array.isArray(content.parts) ? content.parts.filter(isObj) : [];
  const text = parts
    .filter((p) => p.thought !== true && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
  const functionCalls: GeminiFunctionCall[] = [];
  for (const part of parts) {
    const call = part.functionCall;
    if (!isObj(call) || typeof call.name !== 'string' || !call.name) continue;
    functionCalls.push({ ...(typeof call.id === 'string' && call.id ? { id: call.id } : {}), name: call.name, args: isObj(call.args) ? call.args : {} });
  }
  const finishReason = candidate && typeof candidate.finishReason === 'string' ? candidate.finishReason : text || functionCalls.length ? 'STOP' : 'UNKNOWN';
  if (!text && !functionCalls.length) throw noTextError(finishReason);
  return {
    content: content ?? { role: 'model', parts: [] },
    text,
    functionCalls,
    finishReason,
    model: typeof parsed.modelVersion === 'string' && parsed.modelVersion ? parsed.modelVersion : modelName,
    usage: usageOf(parsed),
  };
}

/**
 * One turn of a function-calling conversation. Same URL, header, retries and error translation as `generateContent`.
 * A turn with function calls and no text is a valid answer.
 */
export async function generateTurn(auth: GeminiAuth, request: GeminiTurnRequest, o: GeminiCallOptions = {}): Promise<GeminiTurnResult> {
  const sent = await postGenerate(auth, request.model, buildTurnBody(request), request.maxRetries, o);
  return readTurn(sent.text, sent.model, sent.secrets);
}
