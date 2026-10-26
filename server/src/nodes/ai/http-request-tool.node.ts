import type { JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { HTTP_AUTH_CREDENTIALS, HTTP_AUTH_PROPERTY, httpSend, redact, resolveHttpAuth, statusError } from '../_shared/http-client.js';
import { coerceArgument, readDeclaredParameters, toSchema, toolIdentity, toolIdentityProperties, TOOL_PARAMETERS_PROPERTY, type DeclaredParameter } from '../_shared/ai-tool.js';
import { keyValuePairs } from '../network/http-request.node.js';

// HTTP Request tool for the AI Agent: the workflow author fixes the server, the path and the authentication;
// the model only fills the {placeholders} of the URL and the declared parameters.
// HTTP semantics: https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods (requests are sent by the shared undici client).

const DEFAULT_NAME = 'http_request';
const DEFAULT_DESCRIPTION = 'Calls a web API and returns its answer (status and body). Fill in the parameters to call it.';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** scheme://authority (authority = userinfo, host and port) then path, query and fragment. */
const URL_PARTS = /^(https?):\/\/([^/?#]*)([\s\S]*)$/i;
const NOTE_LIMIT = 300;

interface UrlTemplate {
  /** "https://api.example.com:8443": never contains a placeholder. */
  origin: string;
  /** Path, query and fragment, with {placeholders}. */
  rest: string;
  placeholders: string[];
}

/** Splits the URL; refuses a placeholder anywhere the model could pick the server. */
export function parseUrlTemplate(raw: string): UrlTemplate {
  const url = raw.trim();
  if (!url) throw new NodeOperationError('The URL is empty', { hint: 'Enter an address such as https://api.example.com/items/{id}.' });
  const parts = URL_PARTS.exec(url);
  if (!parts) {
    throw new NodeOperationError(`"${url}" is not a valid URL`, {
      hint: 'It must start with http:// or https://. A {placeholder} is not allowed in the scheme, host or port: the model must never choose the server.',
    });
  }
  const [, scheme, authority, rest] = parts as unknown as [string, string, string, string];
  if (/[{}]/.test(authority)) {
    throw new NodeOperationError(`A {placeholder} is not allowed in the host or port of the URL ("${authority}")`, {
      hint: 'The model must never choose the server. Put placeholders only in the path or the query, for example https://api.example.com/users/{id}.',
    });
  }
  const placeholders = [...new Set([...rest.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
  try {
    new URL(`${scheme}://${authority}${rest.replace(PLACEHOLDER, 'x')}`);
  } catch {
    throw new NodeOperationError(`"${url}" is not a valid URL`, { hint: 'Check the host name and the port.' });
  }
  return { origin: `${scheme.toLowerCase()}://${authority}`, rest, placeholders };
}

/** Value of a placeholder: always one URL component. "." and ".." are refused (a URL parser treats %2E like a dot). */
function encodeSegment(name: string, value: string): string {
  if (value === '.' || value === '..') throw new Error(`The argument "${name}" cannot be "${value}"`);
  return encodeURIComponent(value);
}

const isMissing = (v: unknown): boolean => v === undefined || v === null || v === '';

function bodyText(body: Buffer, contentType: string, secrets: string[], max: number): unknown {
  if (!body.length) return '';
  if (/^(image|audio|video)\/|application\/(pdf|zip|octet-stream|gzip)/i.test(contentType)) return `[binary content: ${contentType || 'unknown type'}, ${body.length} bytes]`;
  const text = redact(body.toString('utf8'), secrets);
  if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
    if (text.length <= max) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        /* not JSON after all: return the text */
      }
    }
  }
  return text.length > max ? `${text.slice(0, max)}\n[cut: ${text.length - max} more characters not shown]` : text;
}

export default defineNode({
  description: {
    type: 'flowforge.httpRequestTool',
    displayName: 'HTTP Request Tool',
    description: 'Lets the AI Agent call a web API. You fix the server and the authentication, the model fills the parameters.',
    icon: 'lucide:globe',
    group: 'ai-sub',
    version: 1,
    defaults: { name: 'HTTP Request Tool', color: '#4c6ef5' },
    subtitle: '{{method}} {{url}}',
    inputs: [],
    outputs: [{ type: 'ai_tool' }],
    credentials: HTTP_AUTH_CREDENTIALS,
    keywords: ['http', 'api', 'rest', 'request', 'url', 'tool', 'agent', 'ai', 'fetch'],
  },
  properties: [
    ...toolIdentityProperties(DEFAULT_NAME, DEFAULT_DESCRIPTION),
    { name: 'method', displayName: 'Method', type: 'options', default: 'GET', options: METHODS.map((m) => ({ name: m, value: m })), noDataExpression: true },
    {
      name: 'url',
      displayName: 'URL',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'https://api.example.com/users/{id}',
      description: 'Use {name} for a value the model chooses. Placeholders are allowed in the path and the query, never in the host or port.',
    },
    HTTP_AUTH_PROPERTY,
    TOOL_PARAMETERS_PROPERTY,
    {
      name: 'sendIn',
      displayName: 'Send Other Parameters In',
      type: 'options',
      default: 'query',
      options: [
        { name: 'Query String', value: 'query' },
        { name: 'JSON Body', value: 'body', description: 'POST, PUT, PATCH and DELETE only' },
      ],
      description: 'Where the declared parameters that are not {placeholders} of the URL go. A GET request always uses the query string.',
      noDataExpression: true,
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'timeout', displayName: 'Timeout (Seconds)', type: 'number', default: 15, typeOptions: { minValue: 1, maxValue: 300 } },
        { name: 'maxResponseChars', displayName: 'Max Response Characters', type: 'number', default: 4000, typeOptions: { minValue: 100, maxValue: 100000 }, description: 'The answer is cut after this many characters, so it fits in the model context.' },
        { name: 'headers', displayName: 'Headers', type: 'keyValue', default: [], description: 'Fixed headers sent with every call. Put secrets in a credential instead.' },
      ],
    },
  ],
  async supplyData(ctx, itemIndex) {
    const { name, description } = toolIdentity(ctx, itemIndex, DEFAULT_NAME, DEFAULT_DESCRIPTION);
    const method = String(ctx.getNodeParameter('method', itemIndex, 'GET') || 'GET').toUpperCase();
    if (!METHODS.includes(method)) throw new NodeOperationError(`Method "${method}" is not supported`, { itemIndex, hint: `Use one of: ${METHODS.join(', ')}.` });
    const template = parseUrlTemplate(String(ctx.getNodeParameter<unknown>('url', itemIndex, '') ?? ''));
    const sendIn: 'query' | 'body' = method !== 'GET' && ctx.getNodeParameter<string>('sendIn', itemIndex, 'query') === 'body' ? 'body' : 'query';

    // Declared parameters, plus every {placeholder} of the URL (always required, text by default).
    const declared = readDeclaredParameters(ctx, itemIndex);
    const parameters: DeclaredParameter[] = declared.map((p) => (template.placeholders.includes(p.name) ? { ...p, required: true } : p));
    for (const placeholder of template.placeholders) {
      if (!parameters.some((p) => p.name === placeholder)) parameters.push({ name: placeholder, description: '', type: 'string', required: true });
    }

    const options = ctx.getNodeParameter<JsonObject>('options', itemIndex, {});
    const timeoutMs = Math.min(Math.max(Number(options.timeout ?? 15) || 15, 1), 300) * 1000;
    const maxChars = Math.min(Math.max(Math.trunc(Number(options.maxResponseChars ?? 4000)) || 4000, 100), 100_000);
    const fixedHeaders: Record<string, string> = {};
    for (const [key, value] of keyValuePairs(options.headers)) {
      if (!/^[\w!#$%&'*+.^`|~-]+$/.test(key)) throw new NodeOperationError(`"${key}" is not a valid header name`, { itemIndex, hint: 'Header names have no spaces or colons, e.g. X-Api-Key.' });
      fixedHeaders[key.toLowerCase()] = value;
    }
    // The credential is resolved now (a missing one is reported on this node); its values stay in this closure.
    const auth = await resolveHttpAuth(ctx, ctx.getNodeParameter('authentication', itemIndex, 'none'));

    return {
      name,
      description,
      parameters: toSchema(parameters),
      invoke: async (args, { signal }) => {
        // Only declared parameters are read: anything else the model sends is ignored.
        const values = new Map<string, string | number | boolean>();
        for (const p of parameters) {
          const raw = args[p.name];
          if (isMissing(raw)) {
            if (p.required) throw new Error(`Missing argument "${p.name}"`);
            continue;
          }
          values.set(p.name, coerceArgument(p, raw));
        }

        const rest = template.rest.replace(PLACEHOLDER, (_m, key: string) => encodeSegment(key, String(values.get(key))));
        const url = new URL(`${template.origin}${rest}`);
        if (url.origin !== new URL(template.origin).origin) throw new Error('The URL changed its server: refused');
        const others = parameters.filter((p) => !template.placeholders.includes(p.name) && values.has(p.name));
        if (sendIn === 'query') for (const p of others) url.searchParams.append(p.name, String(values.get(p.name)));
        for (const [key, value] of auth.query) url.searchParams.set(key, value);

        const headers: Record<string, string> = { 'user-agent': 'FlowForge/0.1', accept: 'application/json, text/plain, */*', ...fixedHeaders, ...auth.headers };
        let body: string | undefined;
        if (sendIn === 'body' && others.length) {
          body = JSON.stringify(Object.fromEntries(others.map((p) => [p.name, values.get(p.name)])));
          headers['content-type'] = 'application/json';
        }

        let result;
        try {
          result = await httpSend({ method, url: url.toString(), headers, body, timeoutMs, followRedirects: true, maxRedirects: 5, ignoreSsl: false, signal, secrets: auth.secrets });
        } catch (err) {
          if (signal.aborted) throw err;
          const e = err as Error & { hint?: string };
          if (e instanceof NodeOperationError) {
            e.message = redact(e.message, auth.secrets);
            if (e.description) e.description = redact(e.description, auth.secrets);
            if (e.hint) e.hint = redact(e.hint, auth.secrets);
            throw e;
          }
          throw new Error(redact(e.message, auth.secrets));
        }
        if (result.statusCode >= 400) {
          const failure = statusError(result, auth.secrets, auth);
          const detail = failure.description ? `: ${failure.description.length > NOTE_LIMIT ? `${failure.description.slice(0, NOTE_LIMIT)}…` : failure.description}` : '';
          failure.message = `${failure.message}${detail}`;
          throw failure;
        }
        return { status: result.statusCode, body: bodyText(result.body, result.headers['content-type'] ?? '', auth.secrets, maxChars) };
      },
    };
  },
});
