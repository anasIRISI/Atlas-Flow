import { Agent, fetch, type BodyInit, type Response } from 'undici';
import type { NodeDescription, NodeProperty } from '@flowforge/shared';
import { CredentialError, NodeOperationError } from '../../engine/errors.js';
import type { ExecuteContext } from '../../engine/types.js';

// HTTP client shared by the HTTP Request and GraphQL nodes (undici: timeouts, manual redirects, TLS options).

export const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// One connection pool for every node: connections are reused for a while (a bot that answers several messages does
// not pay the TLS handshake each time) and a slow network gets 30 s to connect (the request timeout still applies).
const CONNECT = { timeout: 30_000 };
const POOL = { keepAliveTimeout: 15_000, keepAliveMaxTimeout: 60_000 };
const defaultAgent = new Agent({ ...POOL, connect: CONNECT });
let insecureAgent: Agent | undefined;

export interface HttpSendOptions {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: BodyInit;
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  ignoreSsl: boolean;
  /** Stops the request when the execution is canceled. */
  signal: AbortSignal;
  /** Values that must never show up in an error message (passwords, API keys in the URL…). */
  secrets: string[];
}

export interface HttpResult {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: Buffer;
  /** Final URL after redirects. */
  url: string;
}

/** Replaces every secret by *** (also their URL-encoded form). */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue;
    out = out.split(secret).join('***').split(encodeURIComponent(secret)).join('***');
  }
  return out;
}

export function parseUrl(url: unknown): URL {
  const text = String(url ?? '').trim();
  if (!text) throw new NodeOperationError('The URL is empty', { hint: 'Enter an address such as https://api.example.com/users.' });
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new NodeOperationError(`"${text}" is not a valid URL`, { hint: /^[\w.-]+(:\d+)?(\/|$)/.test(text) ? `Did you mean https://${text} ?` : 'It must start with http:// or https://' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new NodeOperationError(`Only http:// and https:// URLs are supported (got ${parsed.protocol}//)`);
  return parsed;
}

async function readBody(res: Response, limit: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > limit) throw new NodeOperationError(`The response is larger than ${Math.round(limit / 1024 / 1024)} MB`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function failure(err: unknown, url: URL, o: HttpSendOptions, timedOut: boolean): NodeOperationError {
  if (err instanceof NodeOperationError) return err;
  const where = url.host;
  if (timedOut) {
    return new NodeOperationError(`No answer from ${where} within ${Math.round(o.timeoutMs / 100) / 10} s`, { hint: 'The server is slow or unreachable. Raise the timeout in the options, or enable "Retry On Fail" in the node settings.' });
  }
  const e = err as Error & { cause?: { code?: string; message?: string } };
  const code = e.cause?.code ?? (e as { code?: string }).code ?? '';
  const detail = redact(e.cause?.message ?? e.message ?? String(err), o.secrets);
  if (/bad port/i.test(detail)) {
    return new NodeOperationError(`Port ${url.port} is blocked for web requests`, { hint: 'A few reserved ports (such as 1, 22, 25 or 6000) are refused for safety. Use the real port of the web server.' });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new NodeOperationError(`The server "${url.hostname}" could not be found`, { hint: 'Check the spelling of the address and your internet connection.' });
  if (code === 'ECONNREFUSED') return new NodeOperationError(`Connection refused by ${where}`, { hint: 'Nothing is listening there. Is the server running, and is the port right?' });
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') return new NodeOperationError(`${where} closed the connection`, { hint: 'Try again; enable "Retry On Fail" in the node settings if it happens often.' });
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return new NodeOperationError(`Could not connect to ${where} in time`, { hint: 'Check the address, a firewall or VPN may block it.' });
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|SSL/i.test(code) || /certificate|self.signed/i.test(detail)) {
    return new NodeOperationError(`The SSL certificate of ${where} is not trusted`, { description: detail, hint: 'Only if you trust this server: turn on "Ignore SSL Issues" in the options.' });
  }
  return new NodeOperationError(`The request to ${where} failed: ${detail}`);
}

/** Sends one request; follows redirects itself so their number can be limited and credentials stay on the first host. */
export async function httpSend(o: HttpSendOptions): Promise<HttpResult> {
  let url = parseUrl(o.url);
  let method = o.method.toUpperCase();
  let body = o.body;
  let headers = { ...o.headers };
  const timeout = AbortSignal.timeout(Math.max(1, o.timeoutMs));
  const signal = AbortSignal.any([o.signal, timeout]);
  if (o.ignoreSsl) insecureAgent ??= new Agent({ ...POOL, connect: { ...CONNECT, rejectUnauthorized: false } });

  for (let hop = 0; ; hop++) {
    let res: Response;
    let data: Buffer;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'manual',
        signal,
        dispatcher: o.ignoreSsl ? insecureAgent : defaultAgent,
        ...(body && typeof (body as { pipe?: unknown }).pipe === 'function' ? { duplex: 'half' as const } : {}),
      });
      const location = res.headers.get('location');
      if (o.followRedirects && REDIRECTS.has(res.status) && location) {
        await res.body?.cancel().catch(() => undefined);
        if (hop >= o.maxRedirects) throw new NodeOperationError(`Too many redirects (more than ${o.maxRedirects})`, { hint: `The last one pointed to ${redact(location, o.secrets)}. Raise "Max Redirects" or turn "Follow Redirects" off to see the answer.` });
        const next = new URL(location, url);
        if (!['http:', 'https:'].includes(next.protocol)) throw new NodeOperationError(`The server redirected to an unsupported address (${next.protocol}//)`);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
          method = 'GET';
          body = undefined;
          headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-(type|length)$/i.test(k)));
        }
        // Credentials are for the first server only.
        if (next.host !== url.host) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|proxy-authorization)$/i.test(k)));
        url = next;
        continue;
      }
      data = await readBody(res, MAX_RESPONSE_BYTES);
    } catch (err) {
      if (o.signal.aborted) throw o.signal.reason;
      throw failure(err, url, o, timeout.aborted);
    }
    const out: Record<string, string> = {};
    res.headers.forEach((value, key) => (out[key] = value));
    return { statusCode: res.status, statusMessage: res.statusText, headers: out, body: data, url: url.toString() };
  }
}

const STATUS_HINTS: Record<number, string> = {
  400: 'The server did not understand the request: check the parameters and the body.',
  401: 'The server needs valid credentials: check the authentication of this node.',
  403: 'The server refuses this request: the credentials may lack the permission.',
  404: 'Nothing exists at this address: check the URL (and the HTTP method).',
  405: 'This address does not accept this HTTP method.',
  408: 'The server gave up waiting: try again.',
  413: 'The body is too large for this server.',
  415: 'The server does not accept this body type: check "Body Content Type".',
  422: 'The server understood the request but refused its content: check the body fields.',
  429: 'Too many requests: wait a moment, or enable "Retry On Fail" in the node settings.',
};

/** Error for a 4xx / 5xx answer, with the start of the body as details. */
export function statusError(result: HttpResult, secrets: string[], auth?: ResolvedHttpAuth): NodeOperationError {
  const text = result.body.length && !/^(image|audio|video|application\/(pdf|zip|octet-stream))/.test(result.headers['content-type'] ?? '') ? result.body.toString('utf8', 0, 2000).trim() : '';
  const description = text ? redact(text.length > 600 ? `${text.slice(0, 600)}…` : text, secrets) : undefined;
  const message = `The server answered ${result.statusCode}${result.statusMessage ? ` ${result.statusMessage}` : ''}`;
  const hint = STATUS_HINTS[result.statusCode] ?? (result.statusCode >= 500 ? 'The problem is on the server side: try again later, or enable "Retry On Fail" in the node settings.' : undefined);
  if (result.statusCode === 401 && auth?.credentialType) {
    return new CredentialError(message, { credentialType: auth.credentialType, credentialId: auth.credentialId, description, hint: 'The server refused the credential: check its values.' });
  }
  return new NodeOperationError(message, { description, hint });
}

// ── Authentication through credentials ───────────────────────────────────────

export const HTTP_AUTH_PROPERTY: NodeProperty = {
  name: 'authentication',
  displayName: 'Authentication',
  type: 'options',
  default: 'none',
  options: [
    { name: 'None', value: 'none' },
    { name: 'Basic Auth', value: 'basicAuth', description: 'User and password' },
    { name: 'Bearer Token', value: 'bearerAuth', description: 'Authorization: Bearer <token>' },
    { name: 'API Key in a Header', value: 'headerAuth', description: 'e.g. X-API-Key: <key>' },
    { name: 'API Key in the URL', value: 'queryAuth', description: 'e.g. ?api_key=<key>' },
  ],
  noDataExpression: true,
};

const CREDENTIAL_BY_AUTH: Record<string, string> = { basicAuth: 'httpBasicAuth', bearerAuth: 'httpBearerAuth', headerAuth: 'httpHeaderAuth', queryAuth: 'httpQueryAuth' };

/** `description.credentials` of a node using HTTP_AUTH_PROPERTY: one selector per authentication choice. */
export const HTTP_AUTH_CREDENTIALS: NonNullable<NodeDescription['credentials']> = Object.entries(CREDENTIAL_BY_AUTH).map(([authentication, type]) => ({
  type,
  required: true,
  displayOptions: { show: { authentication: [authentication] } },
}));

export interface ResolvedHttpAuth {
  headers: Record<string, string>;
  query: [string, string][];
  secrets: string[];
  credentialType?: string;
  credentialId?: string;
}

/** Headers / query parameters of the chosen authentication (values come from the encrypted credential). */
export async function resolveHttpAuth(ctx: ExecuteContext, authentication: unknown): Promise<ResolvedHttpAuth> {
  const type = CREDENTIAL_BY_AUTH[String(authentication ?? 'none')];
  if (!type) return { headers: {}, query: [], secrets: [] };
  const credential = await ctx.getCredentials(type);
  const d = credential.data;
  const base = { credentialType: type, credentialId: credential.id };
  if (type === 'httpBasicAuth') {
    const token = Buffer.from(`${String(d.user ?? '')}:${String(d.password ?? '')}`).toString('base64');
    return { ...base, headers: { authorization: `Basic ${token}` }, query: [], secrets: [String(d.password ?? ''), token] };
  }
  if (type === 'httpBearerAuth') {
    const token = String(d.token ?? '').replace(/^Bearer\s+/i, '').trim();
    return { ...base, headers: { authorization: `Bearer ${token}` }, query: [], secrets: [token] };
  }
  const name = String(d.name ?? '').trim();
  const value = String(d.value ?? '');
  if (!name) throw new CredentialError('The credential has no parameter / header name', { ...base });
  return type === 'httpHeaderAuth' ? { ...base, headers: { [name.toLowerCase()]: value }, query: [], secrets: [value] } : { ...base, headers: {}, query: [[name, value]], secrets: [value] };
}
