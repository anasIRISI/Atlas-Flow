// Telegram Bot API client.
// Docs: https://core.telegram.org/bots/api  (sections: "Making requests", "getUpdates", "Available methods")
//
// Every call is `POST {baseUrl}/bot<token>/<method>` with a JSON body (multipart/form-data when a file is uploaded).
// The answer is `{ ok: true, result }` or `{ ok: false, error_code, description, parameters?: { retry_after } }`.
// The bot token is part of the URL: it is always passed to `httpSend` as a secret and removed from every text
// that leaves this file (messages, hints).
import { FormData } from 'undici';
import { httpSend, redact } from '../nodes/_shared/http-client.js';
import { IntegrationError } from './errors.js';

export const TELEGRAM_DEFAULT_BASE_URL = 'https://api.telegram.org';

/** The only methods this client is allowed to call. */
export type TelegramMethod =
  | 'getMe'
  | 'getUpdates'
  | 'deleteWebhook'
  | 'sendMessage'
  | 'sendPhoto'
  | 'sendDocument'
  | 'editMessageText'
  | 'deleteMessage'
  | 'answerCallbackQuery'
  | 'getChat';

export interface TelegramAuth {
  token: string;
  /** Default https://api.telegram.org (a self-hosted Bot API server, or a local mock in tests). */
  baseUrl?: string;
}

/** A file sent as multipart/form-data (sendPhoto / sendDocument). */
export interface TelegramUpload {
  field: 'photo' | 'document';
  data: Buffer;
  fileName: string;
  mimeType?: string;
}

export interface TelegramCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Retries after a 429 whose wait is ≤ 10 s (default 2; the poll loop of the hub handles 429 itself). */
  maxRetries?: number;
  upload?: TelegramUpload;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

const SERVICE = 'Telegram';
const MAX_RETRY_WAIT_MS = 10_000;

/** token / chat id / base URL out of the values of a `telegramApi` credential. */
export function telegramAuthFrom(data: Record<string, unknown>): TelegramAuth & { chatId: string } {
  return {
    token: String(data.accessToken ?? '').trim(),
    baseUrl: String(data.baseUrl ?? '').trim() || TELEGRAM_DEFAULT_BASE_URL,
    chatId: String(data.chatId ?? '').trim(),
  };
}

/** Resolves after `ms`, or as soon as the signal aborts (the caller checks `signal.aborted`). */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function baseOf(raw: string | undefined): string {
  const text = (raw ?? '').trim() || TELEGRAM_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new IntegrationError(SERVICE, `The Base URL "${text}" is not a valid address`, { hint: `Leave it empty, or use ${TELEGRAM_DEFAULT_BASE_URL}. It must start with http:// or https://.`, auth: true });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IntegrationError(SERVICE, 'The Base URL must start with http:// or https://', { hint: `Use ${TELEGRAM_DEFAULT_BASE_URL}.`, auth: true });
  }
  return url.toString().replace(/\/+$/, '');
}

interface TelegramAnswer {
  ok?: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

function parseAnswer(body: Buffer): TelegramAnswer | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as TelegramAnswer) : undefined;
  } catch {
    return undefined;
  }
}

/** A failed Telegram answer in plain words, with what the user can do about it. Never contains the token. */
export function describeTelegramError(method: string, status: number, body: unknown, token: string): IntegrationError {
  const answer = (body && typeof body === 'object' ? body : {}) as TelegramAnswer;
  const code = answer.error_code ?? status;
  const description = redact(String(answer.description ?? '').trim(), [token]);
  const info = { status: code, code: String(code) };

  if (code === 401 || code === 404) {
    return new IntegrationError(SERVICE, 'Telegram rejected the bot token', {
      ...info,
      auth: true,
      hint: 'Check the bot token in the Telegram credential (or TELEGRAM_BOT_TOKEN in .env). Copy it again from @BotFather: /mybots → your bot → API Token.',
    });
  }
  if (code === 409 && method === 'getUpdates') {
    return new IntegrationError(SERVICE, 'Another program is reading the updates of this bot', {
      ...info,
      hint: 'Only one program can poll a bot. Stop the other one (another FlowForge, n8n, a script) or create a second bot with @BotFather.',
    });
  }
  if (code === 429) {
    const seconds = Number(answer.parameters?.retry_after);
    const retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
    return new IntegrationError(SERVICE, 'Telegram says there are too many requests', {
      ...info,
      retryAfterMs,
      hint: `Wait ${retryAfterMs === undefined ? 'a moment' : `${Math.ceil(retryAfterMs / 1000)} seconds`} before sending again, or send fewer messages at once.`,
    });
  }
  if (code === 403) {
    const blocked = /blocked/i.test(description);
    return new IntegrationError(SERVICE, `Telegram refused: ${description || 'Forbidden'}`, {
      ...info,
      hint: blocked ? 'The user blocked the bot. They have to unblock it and press Start again.' : 'The bot is not allowed to do this: add it to the chat (as administrator for channels) or let the user press Start first.',
    });
  }
  if (code === 400) {
    let hint: string | undefined;
    if (/chat not found/i.test(description)) hint = 'Check the Chat ID. A person must press Start in your bot first; for groups and channels, add the bot there.';
    else if (/can't parse entities/i.test(description)) hint = 'The text contains characters that Parse Mode does not allow. Escape them, or set Parse Mode to None.';
    else if (/message is not modified/i.test(description)) hint = 'The new text and keyboard are identical to the current message.';
    else if (/message to (edit|delete) not found|message can't be (edited|deleted)/i.test(description)) hint = 'Check the Message ID (and that the bot sent that message, or may delete it).';
    else if (/message text is empty|text must be non-empty/i.test(description)) hint = 'The message text is empty.';
    else if (/query is too old|query ID is invalid/i.test(description)) hint = 'A callback query must be answered soon after the button was pressed, and only once.';
    return new IntegrationError(SERVICE, `Telegram refused the request: ${description || 'Bad Request'}`, { ...info, hint });
  }
  const text = description || (status ? `HTTP ${status}` : 'unknown error');
  return new IntegrationError(SERVICE, `Telegram answered with an error: ${text}`, {
    ...info,
    hint: code >= 500 ? 'The problem is on the Telegram side: try again later, or enable "Retry On Fail" in the node settings.' : undefined,
  });
}

function formOf(params: Record<string, unknown>, upload: TelegramUpload): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  form.append(upload.field, new Blob([new Uint8Array(upload.data)], { type: upload.mimeType || 'application/octet-stream' }), upload.fileName);
  return form;
}

/** Calls one Bot API method and returns its `result`. */
export async function telegramCall<T = unknown>(auth: TelegramAuth, method: TelegramMethod, params: Record<string, unknown> = {}, o: TelegramCallOptions = {}): Promise<T> {
  const token = auth.token.trim();
  if (!token) {
    throw new IntegrationError(SERVICE, 'The bot token is empty', { auth: true, hint: 'Enter the token of your bot in the Telegram credential (or set TELEGRAM_BOT_TOKEN in .env). Create one with @BotFather.' });
  }
  const url = `${baseOf(auth.baseUrl)}/bot${token}/${method}`;
  const signal = o.signal ?? new AbortController().signal;
  const maxRetries = o.maxRetries ?? 2;

  for (let attempt = 0; ; attempt++) {
    const result = await httpSend({
      method: 'POST',
      url,
      headers: o.upload ? {} : { 'content-type': 'application/json' },
      body: o.upload ? formOf(params, o.upload) : JSON.stringify(params),
      timeoutMs: o.timeoutMs ?? 30_000,
      followRedirects: false,
      maxRedirects: 0,
      ignoreSsl: false,
      signal,
      secrets: [token],
    });
    const answer = parseAnswer(result.body);
    if (result.statusCode >= 200 && result.statusCode < 300 && answer?.ok === true) return answer.result as T;

    if (!answer) {
      throw new IntegrationError(SERVICE, result.statusCode >= 200 && result.statusCode < 300 ? 'Telegram sent an answer that is not valid JSON' : `Telegram answered HTTP ${result.statusCode} without a readable body`, {
        status: result.statusCode,
        hint: 'Check the Base URL of the Telegram credential: it should be https://api.telegram.org (or empty).',
        auth: result.statusCode === 401 || result.statusCode === 404,
      });
    }
    const error = describeTelegramError(method, result.statusCode, answer, token);
    if (error.status === 429 && attempt < maxRetries && error.retryAfterMs !== undefined && error.retryAfterMs <= MAX_RETRY_WAIT_MS) {
      await abortableSleep(error.retryAfterMs, signal);
      signal.throwIfAborted();
      continue;
    }
    throw error;
  }
}

export function getMe(auth: TelegramAuth, o: TelegramCallOptions = {}): Promise<TelegramUser> {
  return telegramCall<TelegramUser>(auth, 'getMe', {}, o);
}
