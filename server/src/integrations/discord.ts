// Discord webhook client (no bot, no OAuth: the webhook URL is the only secret).
// Official docs:
//   Webhook resource (get / execute / edit / delete / get message): https://docs.discord.com/developers/resources/webhook
//   Message + embed object and their limits:                       https://docs.discord.com/developers/resources/message
//   Rate limits (429, retry_after, Retry-After):                    https://docs.discord.com/developers/topics/rate-limits
//
// Endpoints used (nothing else):
//   GET    {url}                       webhook object (also holds the TOKEN: never returned from here)
//   POST   {url}?wait=true[&thread_id] execute (wait=true => 200 + Message, otherwise 204)
//   PATCH  {url}/messages/{id}         edit
//   DELETE {url}/messages/{id}         delete (204)
//   GET    {url}/messages/{id}         get one message
//
// The webhook URL and its token never appear in a returned value, an error message or a hint.

import type { JsonObject } from '@flowforge/shared';
import { httpSend, redact } from '../nodes/_shared/http-client.js';
import { IntegrationError } from './errors.js';

const SERVICE = 'Discord';

export const DISCORD_LIMITS = {
  content: 2000,
  embeds: 10,
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  authorName: 256,
  totalEmbedChars: 6000,
} as const;

export const FLAG_SUPPRESS_EMBEDS = 4;
export const FLAG_SUPPRESS_NOTIFICATIONS = 4096;

/** Retry a 429 only when Discord asks for at most this long; at most MAX_TRIES requests in total. */
const MAX_AUTO_WAIT_MS = 10_000;
const MAX_TRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WebhookTarget {
  id: string;
  token: string;
  /** Base URL without query string: https://discord.com/api/webhooks/<id>/<token>. SECRET. */
  url: string;
}

const EXPECTED_FORM = 'https://discord.com/api/webhooks/123456789012345678/AbCdEf…';

/** Checks the shape `/webhooks/<digits>/<token>` (host-agnostic) and strips any query string. Never echoes the URL. */
export function parseWebhookUrl(raw: unknown): WebhookTarget {
  const text = String(raw ?? '').trim();
  if (!text) {
    throw new IntegrationError(SERVICE, 'The Discord webhook URL is empty', {
      auth: true,
      hint: `Paste the webhook URL in the credential (or set DISCORD_WEBHOOK_URL in .env). Discord: channel settings → Integrations → Webhooks → Copy Webhook URL. It looks like ${EXPECTED_FORM}`,
    });
  }
  const invalid = () =>
    new IntegrationError(SERVICE, 'This is not a valid Discord webhook URL', {
      auth: true,
      hint: `The URL must look like ${EXPECTED_FORM} (…/webhooks/<number>/<token>). Copy it again in Discord: channel settings → Integrations → Webhooks → Copy Webhook URL.`,
    });
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw invalid();
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw invalid();
  const match = /^(\/api(?:\/v\d+)?)?\/webhooks\/(\d+)\/([\w-]+)\/?$/.exec(parsed.pathname);
  if (!match) throw invalid();
  const [, prefix = '', id, token] = match as unknown as [string, string | undefined, string, string];
  return { id, token, url: `${parsed.origin}${prefix}/webhooks/${id}/${token}` };
}

// ── Embeds ───────────────────────────────────────────────────────────────────

export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  timestamp?: string;
  color?: number;
  footer?: { text: string; icon_url?: string };
  image?: { url: string };
  thumbnail?: { url: string };
  author?: { name: string; url?: string; icon_url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface EmbedInput {
  title?: unknown;
  description?: unknown;
  url?: unknown;
  /** "#5865F2", "5865F2" or an integer. */
  color?: unknown;
  /** ISO 8601 string or a Date. */
  timestamp?: unknown;
  authorName?: unknown;
  authorUrl?: unknown;
  authorIconUrl?: unknown;
  thumbnailUrl?: unknown;
  imageUrl?: unknown;
  footerText?: unknown;
  footerIconUrl?: unknown;
  /** Array or JSON text of `[{ name, value, inline }]`. */
  fields?: unknown;
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** "#5865F2" → 5865242. Integers pass through (0 … 0xFFFFFF). */
export function parseColor(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 0 && value <= 0xffffff) return value;
  } else {
    const text = String(value).trim();
    const hex = /^#?([0-9a-f]{6})$/i.exec(text) ?? /^#?([0-9a-f]{3})$/i.exec(text);
    if (hex) {
      const digits = hex[1]!.length === 3 ? hex[1]!.replace(/./g, (c) => c + c) : hex[1]!;
      return parseInt(digits, 16);
    }
    if (/^\d+$/.test(text) && Number(text) <= 0xffffff) return Number(text);
  }
  throw new IntegrationError(SERVICE, `The embed color "${str(value).slice(0, 30)}" is not valid`, { hint: 'Use a hex color such as #5865F2.' });
}

function parseFields(value: unknown): NonNullable<Embed['fields']> {
  let list: unknown = value;
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    try {
      list = JSON.parse(value);
    } catch {
      throw new IntegrationError(SERVICE, 'The embed fields are not valid JSON', { hint: 'Use a list such as [{ "name": "Status", "value": "OK", "inline": true }].' });
    }
  }
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new IntegrationError(SERVICE, 'The embed fields must be a JSON list', { hint: 'Use a list such as [{ "name": "Status", "value": "OK", "inline": true }].' });
  return list.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new IntegrationError(SERVICE, `Embed field ${i + 1} is not an object`, { hint: 'Each field looks like { "name": "Status", "value": "OK", "inline": true }.' });
    }
    const e = entry as Record<string, unknown>;
    const field: { name: string; value: string; inline?: boolean } = { name: str(e.name), value: str(e.value) };
    if (e.inline === true || e.inline === 'true') field.inline = true;
    return field;
  });
}

/** Builds an embed object from flat values. Returns undefined when nothing meaningful is set (a color alone does not count). */
export function buildEmbed(input: EmbedInput): Embed | undefined {
  const embed: Embed = {};
  const title = str(input.title);
  const description = str(input.description);
  const url = str(input.url).trim();
  if (title) embed.title = title;
  if (description) embed.description = description;
  if (url) embed.url = url;

  const stamp = input.timestamp;
  if (stamp !== undefined && stamp !== null && stamp !== '') {
    const date = stamp instanceof Date ? stamp : new Date(String(stamp));
    if (Number.isNaN(date.getTime())) {
      throw new IntegrationError(SERVICE, `The embed timestamp "${str(stamp).slice(0, 40)}" is not a date`, { hint: 'Use an ISO 8601 date such as 2026-10-12T09:30:00Z.' });
    }
    embed.timestamp = date.toISOString();
  }

  const footerText = str(input.footerText);
  if (footerText) {
    embed.footer = { text: footerText };
    if (str(input.footerIconUrl).trim()) embed.footer.icon_url = str(input.footerIconUrl).trim();
  }
  if (str(input.imageUrl).trim()) embed.image = { url: str(input.imageUrl).trim() };
  if (str(input.thumbnailUrl).trim()) embed.thumbnail = { url: str(input.thumbnailUrl).trim() };
  const authorName = str(input.authorName);
  if (authorName) {
    embed.author = { name: authorName };
    if (str(input.authorUrl).trim()) embed.author.url = str(input.authorUrl).trim();
    if (str(input.authorIconUrl).trim()) embed.author.icon_url = str(input.authorIconUrl).trim();
  }
  const fields = parseFields(input.fields);
  if (fields.length) embed.fields = fields;

  if (Object.keys(embed).length === 0) return undefined;
  const color = parseColor(input.color);
  if (color !== undefined) embed.color = color;
  return embed;
}

// ── Limits ───────────────────────────────────────────────────────────────────

const limitError = (message: string, hint: string) => new IntegrationError(SERVICE, message, { hint });

/** Throws a clear error (limit + actual size) BEFORE any request. */
export function checkLimits(payload: { content?: string; embeds?: Embed[] }): void {
  const { content, embeds = [] } = payload;
  if (content !== undefined && content.length > DISCORD_LIMITS.content) {
    throw limitError(
      `The message is ${content.length} characters long; Discord allows ${DISCORD_LIMITS.content}`,
      `Shorten the text, put the long part in an embed description (up to ${DISCORD_LIMITS.description}), or set "Long Content" to "Truncate" in the options.`,
    );
  }
  if (embeds.length > DISCORD_LIMITS.embeds) {
    throw limitError(`The message has ${embeds.length} embeds; Discord allows ${DISCORD_LIMITS.embeds}`, 'Remove some embeds, or send them in several messages.');
  }
  let total = 0;
  embeds.forEach((embed, index) => {
    const at = `Embed ${index + 1}`;
    const over = (what: string, value: string | undefined, max: number) => {
      if (value !== undefined && value.length > max) throw limitError(`${at}: the ${what} is ${value.length} characters long; Discord allows ${max}`, `Shorten the ${what} of embed ${index + 1}.`);
      total += value?.length ?? 0;
    };
    over('title', embed.title, DISCORD_LIMITS.title);
    over('description', embed.description, DISCORD_LIMITS.description);
    over('footer text', embed.footer?.text, DISCORD_LIMITS.footerText);
    over('author name', embed.author?.name, DISCORD_LIMITS.authorName);
    const fields = embed.fields ?? [];
    if (fields.length > DISCORD_LIMITS.fields) {
      throw limitError(`${at} has ${fields.length} fields; Discord allows ${DISCORD_LIMITS.fields}`, `Keep at most ${DISCORD_LIMITS.fields} fields per embed.`);
    }
    fields.forEach((field, f) => {
      const fieldAt = `${at}, field ${f + 1}`;
      if (!field.name.trim() || !field.value.trim()) {
        throw limitError(`${fieldAt}: the ${field.name.trim() ? 'value' : 'name'} is empty; Discord needs both a name and a value`, 'Fill both, or remove the field.');
      }
      if (field.name.length > DISCORD_LIMITS.fieldName) {
        throw limitError(`${fieldAt}: the name is ${field.name.length} characters long; Discord allows ${DISCORD_LIMITS.fieldName}`, 'Shorten the field name.');
      }
      if (field.value.length > DISCORD_LIMITS.fieldValue) {
        throw limitError(`${fieldAt}: the value is ${field.value.length} characters long; Discord allows ${DISCORD_LIMITS.fieldValue}`, 'Shorten the field value, or move the text to the embed description.');
      }
      total += field.name.length + field.value.length;
    });
  });
  if (total > DISCORD_LIMITS.totalEmbedChars) {
    throw limitError(
      `The embeds add up to ${total} characters; Discord allows ${DISCORD_LIMITS.totalEmbedChars} in total`,
      'The limit counts titles, descriptions, field names and values, footers and author names of all embeds together.',
    );
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseJson(body: Buffer): unknown {
  if (!body.length) return undefined;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Collects `path: message` lines out of Discord's `errors` tree (Invalid Form Body). */
function collectDetails(node: unknown, path: string[], out: string[]): void {
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (Array.isArray(record._errors)) {
    for (const e of record._errors) out.push(`${path.join('.') || 'body'}: ${str((e as { message?: unknown })?.message)}`);
  }
  for (const [key, value] of Object.entries(record)) if (key !== '_errors') collectDetails(value, [...path, key], out);
}

/** Seconds → ms from the JSON body (`retry_after`, float) or the `Retry-After` header. */
function retryAfterMs(body: unknown, headers: Record<string, string>): number {
  const fromBody = Number((body as { retry_after?: unknown } | undefined)?.retry_after);
  const fromHeader = Number(headers['retry-after']);
  const seconds = Number.isFinite(fromBody) && fromBody >= 0 ? fromBody : Number.isFinite(fromHeader) && fromHeader >= 0 ? fromHeader : 1;
  return Math.ceil(seconds * 1000);
}

const seconds = (ms: number) => Number((ms / 1000).toFixed(2));

interface Reply {
  status: number;
  json: unknown;
}

async function call(target: WebhookTarget, method: string, path: string, query: Record<string, string>, payload: JsonObject | undefined, o: CallOptions): Promise<Reply> {
  const signal = o.signal ?? new AbortController().signal;
  const secrets = [target.url, target.token];
  const qs = new URLSearchParams(query).toString();
  const url = `${target.url}${path}${qs ? `?${qs}` : ''}`;
  for (let attempt = 1; ; attempt++) {
    const res = await httpSend({
      method,
      url,
      headers: { accept: 'application/json', 'user-agent': 'FlowForge', ...(payload ? { 'content-type': 'application/json' } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
      timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      followRedirects: false,
      maxRedirects: 0,
      ignoreSsl: false,
      signal,
      secrets,
    });
    const json = parseJson(res.body);
    if (res.statusCode >= 200 && res.statusCode < 300) return { status: res.statusCode, json };

    const api = (json && typeof json === 'object' ? json : {}) as { message?: unknown; code?: unknown; errors?: unknown };
    const code = api.code === undefined ? undefined : String(api.code);
    const reason = redact(str(api.message), secrets).slice(0, 300);

    if (res.statusCode === 429) {
      const wait = retryAfterMs(json, res.headers);
      if (wait <= MAX_AUTO_WAIT_MS && attempt < MAX_TRIES) {
        await sleep(wait, signal);
        continue;
      }
      throw new IntegrationError(SERVICE, wait > MAX_AUTO_WAIT_MS ? `Discord is rate limiting this webhook for ${seconds(wait)} s` : 'Discord is still rate limiting this webhook after 3 tries', {
        status: 429,
        code,
        retryAfterMs: wait,
        hint: `Discord asks to wait ${seconds(wait)} s. Send fewer messages at once, add a Wait node, or try again later.`,
      });
    }
    if (res.statusCode === 401 || (res.statusCode === 404 && code !== '10008')) {
      throw new IntegrationError(SERVICE, `Discord does not accept this webhook${reason ? ` (${reason})` : ''}`, {
        status: res.statusCode,
        code,
        auth: true,
        hint: 'The webhook was deleted or the URL is incomplete. Create or copy the webhook URL again in Discord (channel settings → Integrations → Webhooks) and update the credential.',
      });
    }
    if (res.statusCode === 404) {
      throw new IntegrationError(SERVICE, 'Discord cannot find this message', {
        status: 404,
        code,
        hint: 'The message ID is wrong, the message was deleted, or it was not sent by this webhook. Message IDs are numbers (right-click a message → Copy Message ID).',
      });
    }
    if (res.statusCode === 400) {
      const details: string[] = [];
      collectDetails(api.errors, [], details);
      const text = redact(details.slice(0, 5).join('; '), secrets);
      throw new IntegrationError(SERVICE, `Discord rejected the message${reason ? ` (${reason})` : ''}${text ? `: ${text}` : ''}`, {
        status: 400,
        code,
        hint: 'Check the content, the embeds (URLs must start with https://) and the thread ID.',
      });
    }
    throw new IntegrationError(SERVICE, `Discord answered ${res.statusCode}${reason ? `: ${reason}` : ''}`, {
      status: res.statusCode,
      code,
      hint: res.statusCode >= 500 ? 'The problem is on Discord\'s side: try again later.' : res.statusCode === 403 ? 'Discord refuses this request: the webhook may lack permission for this channel or thread.' : undefined,
    });
  }
}

/** The result of a successful call must be a JSON object; anything else is reported clearly. */
function asObject(reply: Reply, target: WebhookTarget): JsonObject {
  if (reply.json && typeof reply.json === 'object' && !Array.isArray(reply.json)) {
    // Safety net: never hand the token (or URL) back, even if it shows up in a message text.
    return JSON.parse(redact(JSON.stringify(reply.json), [target.url, target.token])) as JsonObject;
  }
  throw new IntegrationError(SERVICE, 'Discord sent an answer FlowForge could not read', { status: reply.status, hint: 'It was not JSON. Try again; if it keeps happening Discord may be having problems (discordstatus.com).' });
}

function messagePath(messageId: unknown): string {
  const id = str(messageId).trim();
  if (!id) throw new IntegrationError(SERVICE, 'The message ID is empty', { hint: 'Enter the ID of a message sent by this webhook (the "id" field of the Send Message output).' });
  if (!/^\d{1,25}$/.test(id)) throw new IntegrationError(SERVICE, 'The message ID is not valid', { hint: 'A Discord message ID is a number such as 1234567890123456789.' });
  return `/messages/${id}`;
}

const threadQuery = (threadId?: string): Record<string, string> => (threadId?.trim() ? { thread_id: threadId.trim() } : {});

// ── Operations ───────────────────────────────────────────────────────────────

export interface ExecuteInput {
  content?: string;
  username?: string;
  avatarUrl?: string;
  tts?: boolean;
  embeds?: Embed[];
  suppressEmbeds?: boolean;
  suppressNotifications?: boolean;
  threadId?: string;
  /** Default true: Discord answers with the Message object. */
  wait?: boolean;
}

function requireBody(content: string | undefined, embeds: Embed[] | undefined): void {
  if (!content?.length && !embeds?.length) {
    throw new IntegrationError(SERVICE, 'There is nothing to send: the message and the embeds are empty', { hint: 'Enter some message text, or fill at least one embed.' });
  }
}

/** Webhook info WITHOUT the token. */
export async function getWebhook(target: WebhookTarget, o: CallOptions = {}): Promise<JsonObject> {
  const webhook = asObject(await call(target, 'GET', '', {}, undefined, o), target);
  const safe: JsonObject = {};
  for (const key of ['id', 'name', 'channel_id', 'guild_id', 'type', 'application_id']) if (webhook[key] !== undefined) safe[key] = webhook[key]!;
  return safe;
}

/** Sends a message. Returns the Message object (wait, default) or `{ success: true }`. */
export async function executeWebhook(target: WebhookTarget, input: ExecuteInput, o: CallOptions = {}): Promise<JsonObject> {
  requireBody(input.content, input.embeds);
  checkLimits({ content: input.content, embeds: input.embeds });
  const body: JsonObject = {};
  if (input.content) body.content = input.content;
  if (input.username?.trim()) body.username = input.username.trim();
  if (input.avatarUrl?.trim()) body.avatar_url = input.avatarUrl.trim();
  if (input.tts) body.tts = true;
  if (input.embeds?.length) body.embeds = input.embeds as unknown as JsonObject[];
  const flags = (input.suppressEmbeds ? FLAG_SUPPRESS_EMBEDS : 0) | (input.suppressNotifications ? FLAG_SUPPRESS_NOTIFICATIONS : 0);
  if (flags) body.flags = flags;
  const wait = input.wait !== false;
  const reply = await call(target, 'POST', '', { ...(wait ? { wait: 'true' } : {}), ...threadQuery(input.threadId) }, body, o);
  return wait ? asObject(reply, target) : { success: true };
}

export async function editWebhookMessage(
  target: WebhookTarget,
  messageId: string,
  input: { content?: string; embeds?: Embed[]; threadId?: string },
  o: CallOptions = {},
): Promise<JsonObject> {
  const path = messagePath(messageId);
  requireBody(input.content, input.embeds);
  checkLimits({ content: input.content, embeds: input.embeds });
  const body: JsonObject = {};
  if (input.content !== undefined) body.content = input.content;
  if (input.embeds) body.embeds = input.embeds as unknown as JsonObject[];
  return asObject(await call(target, 'PATCH', path, threadQuery(input.threadId), body, o), target);
}

export async function deleteWebhookMessage(target: WebhookTarget, messageId: string, input: { threadId?: string } = {}, o: CallOptions = {}): Promise<void> {
  await call(target, 'DELETE', messagePath(messageId), threadQuery(input.threadId), undefined, o);
}

export async function getWebhookMessage(target: WebhookTarget, messageId: string, input: { threadId?: string } = {}, o: CallOptions = {}): Promise<JsonObject> {
  return asObject(await call(target, 'GET', messagePath(messageId), threadQuery(input.threadId), undefined, o), target);
}
