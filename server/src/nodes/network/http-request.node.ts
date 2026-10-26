import { File } from 'node:buffer';
import { FormData, type BodyInit } from 'undici';
import type { Item, JsonObject, NodeProperty } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode, type ExecuteContext } from '../../engine/types.js';
import { isPlainObject } from '../_shared/fields.js';
import { HTTP_AUTH_CREDENTIALS, HTTP_AUTH_PROPERTY, httpSend, parseUrl, redact, resolveHttpAuth, statusError, type HttpResult, type ResolvedHttpAuth } from '../_shared/http-client.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const on = (conditions: Record<string, unknown[]>): NodeProperty['displayOptions'] => ({ show: conditions });
const text = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** Key/value parameter ([{ name, value }]) → pairs, without the rows that have no name. */
export function keyValuePairs(value: unknown): [string, string][] {
  return (Array.isArray(value) ? (value as Array<{ name?: unknown; value?: unknown }>) : [])
    .filter((p) => p && String(p.name ?? '').trim())
    .map((p) => [String(p.name).trim(), text(p.value)]);
}

/** A "JSON" parameter: text typed in the editor, or the object an expression returned. */
export function jsonValue(raw: unknown, label: string, itemIndex: number): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new NodeOperationError(`${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, {
      itemIndex,
      hint: 'Check the quotes and commas. Names and text need double quotes: {"name": "Ada"}.',
    });
  }
}

type BodyKind = 'none' | 'json' | 'form' | 'multipart' | 'raw' | 'binary';

interface Part {
  name: string;
  value?: string;
  file?: { data: Buffer; fileName: string; mimeType: string };
}

/** One request, kept in a form pagination can change between pages. */
interface RequestState {
  method: string;
  url: URL;
  headers: Record<string, string>;
  kind: BodyKind;
  /** json: any JSON value · form: object of fields. */
  data?: unknown;
  parts?: Part[];
  raw?: string | Buffer;
}

function encodeBody(state: RequestState): { body?: BodyInit; contentType?: string } {
  switch (state.kind) {
    case 'json':
      return { body: JSON.stringify(state.data ?? {}), contentType: 'application/json' };
    case 'form':
      return { body: new URLSearchParams(Object.entries((state.data ?? {}) as Record<string, unknown>).map(([k, v]): [string, string] => [k, text(v)])).toString(), contentType: 'application/x-www-form-urlencoded' };
    case 'multipart': {
      const form = new FormData();
      for (const part of state.parts ?? []) {
        if (part.file) form.append(part.name, new File([part.file.data], part.file.fileName, { type: part.file.mimeType }), part.file.fileName);
        else form.append(part.name, part.value ?? '');
      }
      return { body: form }; // fetch adds the multipart boundary itself
    }
    case 'raw':
    case 'binary':
      return { body: state.raw ?? '' };
    default:
      return {};
  }
}

async function buildRequest(ctx: ExecuteContext, i: number, auth: ResolvedHttpAuth): Promise<RequestState> {
  const method = String(ctx.getNodeParameter('method', i, 'GET')).toUpperCase();
  if (!METHODS.includes(method)) throw new NodeOperationError(`Unknown HTTP method "${method}"`, { itemIndex: i });
  const url = parseUrl(ctx.getNodeParameter('url', i, ''));

  if (ctx.getNodeParameter<boolean>('sendQuery', i, false) === true) {
    if (ctx.getNodeParameter<string>('specifyQuery', i, 'keypair') === 'json') {
      const value = jsonValue(ctx.getNodeParameter('jsonQuery', i, ''), 'The query JSON', i);
      if (!isPlainObject(value)) throw new NodeOperationError('The query JSON must be an object, e.g. {"page": 1}', { itemIndex: i });
      for (const [k, v] of Object.entries(value)) {
        for (const single of Array.isArray(v) ? v : [v]) url.searchParams.append(k, text(single));
      }
    } else for (const [k, v] of keyValuePairs(ctx.getNodeParameter('queryParameters', i, []))) url.searchParams.append(k, v);
  }
  for (const [k, v] of auth.query) url.searchParams.set(k, v);

  const headers: Record<string, string> = {};
  if (ctx.getNodeParameter<boolean>('sendHeaders', i, false) === true) {
    if (ctx.getNodeParameter<string>('specifyHeaders', i, 'keypair') === 'json') {
      const value = jsonValue(ctx.getNodeParameter('jsonHeaders', i, ''), 'The headers JSON', i);
      if (!isPlainObject(value)) throw new NodeOperationError('The headers JSON must be an object, e.g. {"Accept": "application/json"}', { itemIndex: i });
      for (const [k, v] of Object.entries(value)) headers[k.toLowerCase()] = text(v);
    } else for (const [k, v] of keyValuePairs(ctx.getNodeParameter('headerParameters', i, []))) headers[k.toLowerCase()] = v;
  }
  for (const name of Object.keys(headers)) {
    if (!/^[\w!#$%&'*+.^`|~-]+$/.test(name)) throw new NodeOperationError(`"${name}" is not a valid header name`, { itemIndex: i, hint: 'Header names have no spaces or colons, e.g. X-Api-Key.' });
  }
  Object.assign(headers, auth.headers);

  const state: RequestState = { method, url, headers, kind: 'none' };
  if (ctx.getNodeParameter<boolean>('sendBody', i, false) !== true || method === 'GET' || method === 'HEAD') return state;

  const contentType = String(ctx.getNodeParameter('contentType', i, 'json'));
  if (contentType === 'json') {
    state.kind = 'json';
    if (ctx.getNodeParameter<string>('specifyBody', i, 'keypair') === 'json') state.data = jsonValue(ctx.getNodeParameter('jsonBody', i, ''), 'The JSON body', i);
    else {
      // Values keep their type (a number stays a number in the JSON).
      const fields = ctx.getNodeParameter<Array<{ name?: unknown; value?: unknown }>>('bodyParameters', i, []);
      state.data = Object.fromEntries((Array.isArray(fields) ? fields : []).filter((p) => String(p?.name ?? '').trim()).map((p) => [String(p.name).trim(), p.value ?? '']));
    }
  } else if (contentType === 'form-urlencoded') {
    state.kind = 'form';
    state.data = Object.fromEntries(keyValuePairs(ctx.getNodeParameter('formParameters', i, [])));
  } else if (contentType === 'multipart-form-data') {
    state.kind = 'multipart';
    state.parts = [];
    for (const p of ctx.getNodeParameter<Array<Record<string, unknown>>>('multipartParameters.values', i, [])) {
      const name = String(p?.name ?? '').trim();
      if (!name) continue;
      if (p.parameterType === 'formBinaryData') {
        const property = String(p.inputDataFieldName || 'data');
        const ref = ctx.getInputData()[i]?.binary?.[property];
        const data = await ctx.helpers.getBinaryDataBuffer(i, property);
        state.parts.push({ name, file: { data, fileName: ref?.fileName ?? property, mimeType: ref?.mimeType ?? 'application/octet-stream' } });
      } else state.parts.push({ name, value: text(p.value) });
    }
  } else if (contentType === 'raw') {
    state.kind = 'raw';
    state.raw = text(ctx.getNodeParameter('body', i, ''));
    headers['content-type'] ??= String(ctx.getNodeParameter('rawContentType', i, 'text/plain') || 'text/plain');
  } else if (contentType === 'binaryData') {
    const property = String(ctx.getNodeParameter('inputDataFieldName', i, 'data') || 'data');
    state.kind = 'binary';
    state.raw = await ctx.helpers.getBinaryDataBuffer(i, property);
    headers['content-type'] ??= ctx.getInputData()[i]?.binary?.[property]?.mimeType ?? 'application/octet-stream';
  } else throw new NodeOperationError(`Unknown body content type "${contentType}"`, { itemIndex: i });
  return state;
}

// ── Response → items ─────────────────────────────────────────────────────────

function detectFormat(result: HttpResult): 'json' | 'text' | 'file' {
  const type = (result.headers['content-type'] ?? '').toLowerCase();
  if (/[/+]json\b/.test(type)) return 'json';
  if (/^text\/|[/+]xml\b|javascript|x-www-form-urlencoded|graphql/.test(type)) return 'text';
  if (!type) {
    // No content type: JSON-looking text is treated as JSON, other printable text as text.
    const start = result.body.toString('utf8', 0, 200).trimStart();
    if (start.startsWith('{') || start.startsWith('[')) return 'json';
    return result.body.includes(0) ? 'file' : 'text';
  }
  return 'file';
}

function fileNameOf(result: HttpResult): string {
  const disposition = result.headers['content-disposition'] ?? '';
  const encoded = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(disposition);
  if (plain) return (plain[2] ?? plain[1]!).trim();
  try {
    const last = decodeURIComponent(new URL(result.url).pathname.split('/').filter(Boolean).pop() ?? '');
    if (last) return last;
  } catch {
    /* fall through */
  }
  return 'file';
}

interface ResponseOptions {
  format: string;
  fullResponse: boolean;
  outputPropertyName: string;
  splitIntoItems: boolean;
}

/** Parsed body (JSON value or text) of a response, used for the output and for `$response.body`. */
function parseBody(result: HttpResult, format: string, itemIndex: number): { kind: 'json' | 'text' | 'file'; value?: unknown } {
  // Nothing came back (204, HEAD…): there is no body to read.
  if (format === 'autodetect' && result.body.length === 0) return { kind: 'json', value: undefined };
  const kind = format === 'autodetect' ? detectFormat(result) : (format as 'json' | 'text' | 'file');
  if (kind === 'file') return { kind };
  const body = result.body.toString('utf8').replace(/^﻿/, '');
  if (kind === 'text') return { kind, value: body };
  if (!body.trim()) return { kind: 'json', value: undefined };
  try {
    return { kind: 'json', value: JSON.parse(body) };
  } catch (err) {
    // Autodetect: a server that announces JSON but sends something else still gives its text.
    if (format === 'autodetect') return { kind: 'text', value: body };
    throw new NodeOperationError(`The response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, {
      itemIndex,
      description: body.slice(0, 300),
      hint: 'Set "Response Format" to Text (or Autodetect) in the options.',
    });
  }
}

async function toItems(ctx: ExecuteContext, i: number, result: HttpResult, parsed: ReturnType<typeof parseBody>, o: ResponseOptions): Promise<Item[]> {
  const meta = { headers: result.headers, statusCode: result.statusCode, statusMessage: result.statusMessage };
  const paired = { pairedItem: { item: i } };
  if (parsed.kind === 'file') {
    const mimeType = (result.headers['content-type'] ?? '').split(';')[0]!.trim() || undefined;
    const ref = await ctx.helpers.prepareBinaryData(result.body, fileNameOf(result), mimeType);
    return [{ json: o.fullResponse ? meta : { fileName: ref.fileName ?? 'file', mimeType: ref.mimeType, fileSize: ref.fileSize }, binary: { [o.outputPropertyName]: ref }, ...paired }];
  }
  if (o.fullResponse) return [{ json: { body: (parsed.value ?? null) as JsonObject[string], ...meta }, ...paired }];
  if (parsed.kind === 'text') return [{ json: { [o.outputPropertyName]: parsed.value as string }, ...paired }];
  const value = parsed.value;
  if (value === undefined) return [{ json: { statusCode: result.statusCode, statusMessage: result.statusMessage }, ...paired }];
  if (Array.isArray(value) && o.splitIntoItems) return value.map((element) => ({ json: isPlainObject(element) ? element : { [o.outputPropertyName]: element as JsonObject[string] }, ...paired }));
  return [{ json: isPlainObject(value) ? value : { [o.outputPropertyName]: value as JsonObject[string] }, ...paired }];
}

const isEmptyBody = (value: unknown, result: HttpResult) =>
  result.body.length === 0 || value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0) || (isPlainObject(value) && Object.keys(value).length === 0);

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

export default defineNode({
  description: {
    type: 'flowforge.httpRequest',
    displayName: 'HTTP Request',
    description: 'Calls any URL or REST API: all methods, query, headers, body, authentication, pagination, files.',
    icon: 'lucide:globe',
    group: 'network',
    version: 1,
    defaults: { name: 'HTTP Request', color: '#4c6ef5' },
    subtitle: '{{method}} {{url}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: HTTP_AUTH_CREDENTIALS,
    keywords: ['http', 'api', 'rest', 'request', 'url', 'curl', 'fetch', 'get', 'post', 'download', 'webhook'],
  },
  properties: [
    { name: 'curlImport', displayName: 'Import cURL', type: 'curlImport', default: '' },
    { name: 'method', displayName: 'Method', type: 'options', default: 'GET', options: METHODS.map((m) => ({ name: m, value: m })) },
    { name: 'url', displayName: 'URL', type: 'string', default: '', required: true, placeholder: 'https://api.example.com/users' },
    HTTP_AUTH_PROPERTY,

    { name: 'sendQuery', displayName: 'Send Query Parameters', type: 'boolean', default: false, noDataExpression: true },
    {
      name: 'specifyQuery',
      displayName: 'Specify Query Parameters',
      type: 'options',
      default: 'keypair',
      options: [
        { name: 'Using Fields Below', value: 'keypair' },
        { name: 'Using JSON', value: 'json' },
      ],
      displayOptions: on({ sendQuery: [true] }),
      noDataExpression: true,
    },
    { name: 'queryParameters', displayName: 'Query Parameters', type: 'keyValue', default: [], displayOptions: on({ sendQuery: [true], specifyQuery: ['keypair'] }) },
    { name: 'jsonQuery', displayName: 'Query JSON', type: 'json', default: '{\n  "page": 1\n}', displayOptions: on({ sendQuery: [true], specifyQuery: ['json'] }) },

    { name: 'sendHeaders', displayName: 'Send Headers', type: 'boolean', default: false, noDataExpression: true },
    {
      name: 'specifyHeaders',
      displayName: 'Specify Headers',
      type: 'options',
      default: 'keypair',
      options: [
        { name: 'Using Fields Below', value: 'keypair' },
        { name: 'Using JSON', value: 'json' },
      ],
      displayOptions: on({ sendHeaders: [true] }),
      noDataExpression: true,
    },
    { name: 'headerParameters', displayName: 'Headers', type: 'keyValue', default: [], displayOptions: on({ sendHeaders: [true], specifyHeaders: ['keypair'] }) },
    { name: 'jsonHeaders', displayName: 'Headers JSON', type: 'json', default: '{\n  "Accept": "application/json"\n}', displayOptions: on({ sendHeaders: [true], specifyHeaders: ['json'] }) },

    { name: 'sendBody', displayName: 'Send Body', type: 'boolean', default: false, noDataExpression: true },
    {
      name: 'contentType',
      displayName: 'Body Content Type',
      type: 'options',
      default: 'json',
      options: [
        { name: 'JSON', value: 'json' },
        { name: 'Form Urlencoded', value: 'form-urlencoded' },
        { name: 'Form-Data (Multipart)', value: 'multipart-form-data', description: 'Fields and files' },
        { name: 'Raw', value: 'raw', description: 'Any text with your own content type' },
        { name: 'File (Binary)', value: 'binaryData', description: 'A file of the item is the body' },
      ],
      displayOptions: on({ sendBody: [true] }),
      noDataExpression: true,
    },
    {
      name: 'specifyBody',
      displayName: 'Specify Body',
      type: 'options',
      default: 'keypair',
      options: [
        { name: 'Using Fields Below', value: 'keypair' },
        { name: 'Using JSON', value: 'json' },
      ],
      displayOptions: on({ sendBody: [true], contentType: ['json'] }),
      noDataExpression: true,
    },
    { name: 'bodyParameters', displayName: 'Body Fields', type: 'keyValue', default: [], displayOptions: on({ sendBody: [true], contentType: ['json'], specifyBody: ['keypair'] }) },
    { name: 'jsonBody', displayName: 'JSON Body', type: 'json', default: '{\n  "name": "Ada"\n}', displayOptions: on({ sendBody: [true], contentType: ['json'], specifyBody: ['json'] }) },
    { name: 'formParameters', displayName: 'Form Fields', type: 'keyValue', default: [], displayOptions: on({ sendBody: [true], contentType: ['form-urlencoded'] }) },
    {
      name: 'multipartParameters',
      displayName: 'Form-Data Parts',
      type: 'fixedCollection',
      default: { values: [{ parameterType: 'formData', name: '', value: '', inputDataFieldName: 'data' }] },
      typeOptions: { multipleValues: true },
      displayOptions: on({ sendBody: [true], contentType: ['multipart-form-data'] }),
      options: [
        {
          name: 'values',
          displayName: 'Part',
          values: [
            {
              name: 'parameterType',
              displayName: 'Type',
              type: 'options',
              default: 'formData',
              options: [
                { name: 'Text Field', value: 'formData' },
                { name: 'File (Binary)', value: 'formBinaryData' },
              ],
              noDataExpression: true,
            },
            { name: 'name', displayName: 'Name', type: 'string', default: '', placeholder: 'e.g. file' },
            { name: 'value', displayName: 'Value', type: 'string', default: '', displayOptions: { show: { parameterType: ['formData'] } } },
            { name: 'inputDataFieldName', displayName: 'Input Binary Field', type: 'string', default: 'data', displayOptions: { show: { parameterType: ['formBinaryData'] } } },
          ],
        },
      ],
    },
    { name: 'rawContentType', displayName: 'Content Type', type: 'string', default: 'text/plain', placeholder: 'e.g. text/xml', displayOptions: on({ sendBody: [true], contentType: ['raw'] }) },
    { name: 'body', displayName: 'Body', type: 'string', default: '', typeOptions: { rows: 5 }, displayOptions: on({ sendBody: [true], contentType: ['raw'] }) },
    { name: 'inputDataFieldName', displayName: 'Input Binary Field', type: 'string', default: 'data', displayOptions: on({ sendBody: [true], contentType: ['binaryData'] }) },

    {
      name: 'paginationMode',
      displayName: 'Pagination',
      type: 'options',
      default: 'off',
      options: [
        { name: 'Off', value: 'off' },
        { name: 'Update a Parameter in Each Request', value: 'updateAParameterInEachRequest', description: 'e.g. page=1, 2, 3… or offset=0, 100, 200…' },
        { name: 'Response Contains Next URL', value: 'responseContainsNextURL', description: 'The answer says where the next page is' },
      ],
      noDataExpression: true,
    },
    {
      name: 'nextURL',
      displayName: 'Next URL',
      type: 'string',
      default: '{{ $response.body.next }}',
      description: 'Where the next page is, read from the last answer: $response.body, $response.headers, $response.statusCode. Pagination stops when it is empty.',
      displayOptions: on({ paginationMode: ['responseContainsNextURL'] }),
      noDataExpression: true,
    },
    {
      name: 'paginationParameters',
      displayName: 'Parameters To Update',
      type: 'fixedCollection',
      default: { values: [{ type: 'qs', name: 'page', value: '{{ $pageCount + 1 }}' }] },
      typeOptions: { multipleValues: true },
      displayOptions: on({ paginationMode: ['updateAParameterInEachRequest'] }),
      noDataExpression: true,
      options: [
        {
          name: 'values',
          displayName: 'Parameter',
          values: [
            {
              name: 'type',
              displayName: 'Type',
              type: 'options',
              default: 'qs',
              options: [
                { name: 'Query', value: 'qs' },
                { name: 'Body', value: 'body' },
                { name: 'Header', value: 'headers' },
              ],
              noDataExpression: true,
            },
            { name: 'name', displayName: 'Name', type: 'string', default: '', placeholder: 'e.g. page or offset', noDataExpression: true },
            { name: 'value', displayName: 'Value', type: 'string', default: '', placeholder: '{{ $pageCount + 1 }}', description: '$pageCount = number of requests already made (0 for the first one). $response = the last answer.', noDataExpression: true },
          ],
        },
      ],
    },
    {
      name: 'paginationCompleteWhen',
      displayName: 'Pagination Complete When',
      type: 'options',
      default: 'responseIsEmpty',
      options: [
        { name: 'Response Is Empty', value: 'responseIsEmpty' },
        { name: 'Receive Specific Status Code(s)', value: 'receiveSpecificStatusCodes' },
        { name: 'Other (Expression)', value: 'other' },
      ],
      displayOptions: on({ paginationMode: ['updateAParameterInEachRequest', 'responseContainsNextURL'] }),
      noDataExpression: true,
    },
    { name: 'statusCodesWhenComplete', displayName: 'Status Code(s) When Complete', type: 'string', default: '404', placeholder: 'e.g. 204, 404', displayOptions: on({ paginationMode: ['updateAParameterInEachRequest', 'responseContainsNextURL'], paginationCompleteWhen: ['receiveSpecificStatusCodes'] }), noDataExpression: true },
    {
      name: 'completeExpression',
      displayName: 'Complete Expression',
      type: 'string',
      default: '{{ $response.body.items.length === 0 }}',
      description: 'Pagination stops when this is true. That last answer is still part of the output.',
      displayOptions: on({ paginationMode: ['updateAParameterInEachRequest', 'responseContainsNextURL'], paginationCompleteWhen: ['other'] }),
      noDataExpression: true,
    },
    { name: 'maxRequests', displayName: 'Max Pages', type: 'number', default: 100, typeOptions: { minValue: 1, maxValue: 10000 }, description: 'Safety limit on the number of requests.', displayOptions: on({ paginationMode: ['updateAParameterInEachRequest', 'responseContainsNextURL'] }), noDataExpression: true },
    { name: 'requestInterval', displayName: 'Interval Between Requests (ms)', type: 'number', default: 0, typeOptions: { minValue: 0, maxValue: 60000 }, displayOptions: on({ paginationMode: ['updateAParameterInEachRequest', 'responseContainsNextURL'] }), noDataExpression: true },

    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'timeout', displayName: 'Timeout (ms)', type: 'number', default: 10000, typeOptions: { minValue: 1, maxValue: 3600000 }, description: 'How long to wait for the answer of each request.' },
        {
          name: 'responseFormat',
          displayName: 'Response Format',
          type: 'options',
          default: 'autodetect',
          options: [
            { name: 'Autodetect', value: 'autodetect' },
            { name: 'JSON', value: 'json' },
            { name: 'Text', value: 'text' },
            { name: 'File', value: 'file', description: 'Keep the answer as binary data (downloads)' },
          ],
        },
        { name: 'outputPropertyName', displayName: 'Put Output in Field', type: 'string', default: 'data', description: 'Field for a text answer, binary property for a file.' },
        { name: 'fullResponse', displayName: 'Include Response Headers and Status', type: 'boolean', default: false },
        { name: 'neverError', displayName: 'Never Error', type: 'boolean', default: false, description: 'Succeed even when the status code is 4xx or 5xx.' },
        { name: 'followRedirects', displayName: 'Follow Redirects', type: 'boolean', default: true },
        { name: 'maxRedirects', displayName: 'Max Redirects', type: 'number', default: 21, typeOptions: { minValue: 0, maxValue: 100 } },
        { name: 'allowUnauthorizedCerts', displayName: 'Ignore SSL Issues', type: 'boolean', default: false, description: 'Accept invalid or self-signed certificates. Only for servers you trust.' },
        { name: 'splitIntoItems', displayName: 'Split a JSON List Into Items', type: 'boolean', default: true, description: 'A list answer becomes one item per element.' },
      ],
    },
  ],
  async execute(ctx) {
    const authentication = ctx.getNodeParameter('authentication', 0, 'none');
    const auth = await resolveHttpAuth(ctx, authentication);

    const out = await ctx.forEachItem(async (_item, i): Promise<Item[]> => {
      const options = ctx.getNodeParameter<JsonObject>('options', i, {});
      const state = await buildRequest(ctx, i, auth);
      const response: ResponseOptions = {
        format: String(options.responseFormat || 'autodetect'),
        fullResponse: options.fullResponse === true,
        outputPropertyName: String(options.outputPropertyName || 'data'),
        splitIntoItems: options.splitIntoItems !== false,
      };
      const timeoutMs = Math.min(Math.max(Number(options.timeout ?? 10_000) || 10_000, 1), 3_600_000);
      const send = () => {
        const { body, contentType } = encodeBody(state);
        const headers = { 'user-agent': 'FlowForge/0.1', accept: 'application/json, text/plain, */*', ...(contentType ? { 'content-type': contentType } : {}), ...state.headers };
        return httpSend({
          method: state.method,
          url: state.url.toString(),
          headers,
          body,
          timeoutMs,
          followRedirects: options.followRedirects !== false,
          maxRedirects: Math.max(0, Number(options.maxRedirects ?? 21) || 0),
          ignoreSsl: options.allowUnauthorizedCerts === true,
          signal: ctx.signal,
          secrets: auth.secrets,
        });
      };
      const fail = (err: NodeOperationError) => {
        err.itemIndex ??= i;
        return err;
      };

      const mode = String(ctx.getRawParameter('paginationMode') ?? 'off');
      if (mode === 'off') {
        const result = await send();
        if (result.statusCode >= 400 && options.neverError !== true) throw fail(statusError(result, auth.secrets, auth));
        return toItems(ctx, i, result, parseBody(result, response.format, i), response);
      }

      // ── Pagination ──
      const template = (raw: unknown, extra: Record<string, unknown>) =>
        typeof raw === 'string' && raw.includes('{{') ? ctx.evaluateExpression(`=${raw.replace(/^=/, '')}`, i, extra) : typeof raw === 'string' ? raw.replace(/^=/, '') : raw;
      const completeWhen = String(ctx.getRawParameter('paginationCompleteWhen') ?? 'responseIsEmpty');
      const doneCodes = String(ctx.getRawParameter('statusCodesWhenComplete') ?? '')
        .split(',')
        .map((c) => Number(c.trim()))
        .filter((c) => Number.isInteger(c) && c > 0);
      const maxRequests = Math.min(Math.max(Math.floor(Number(ctx.getRawParameter('maxRequests') ?? 100)) || 100, 1), 10_000);
      const interval = Math.min(Math.max(Number(ctx.getRawParameter('requestInterval') ?? 0) || 0, 0), 60_000);
      const updates = ((ctx.getRawParameter('paginationParameters') as { values?: Array<Record<string, unknown>> } | undefined)?.values ?? []).filter((u) => String(u?.name ?? '').trim());
      if (mode === 'updateAParameterInEachRequest' && updates.length === 0) {
        throw new NodeOperationError('Pagination: add a parameter to update in each request', { itemIndex: i, hint: 'For example the query parameter "page" with the value {{ $pageCount + 1 }}.' });
      }

      const items: Item[] = [];
      let last: { body: unknown; headers: Record<string, string>; statusCode: number; statusMessage: string } = { body: undefined, headers: {}, statusCode: 0, statusMessage: '' };
      for (let page = 0; page < maxRequests; page++) {
        const extra = { $pageCount: page, $response: last };
        if (mode === 'updateAParameterInEachRequest') {
          for (const update of updates) {
            const name = String(update.name).trim();
            const value = template(update.value, extra);
            if (update.type === 'headers') state.headers[name.toLowerCase()] = text(value);
            else if (update.type === 'body') {
              if (state.kind !== 'json' && state.kind !== 'form') {
                throw new NodeOperationError(`Pagination cannot set the body field "${name}"`, { itemIndex: i, hint: 'Turn on "Send Body" with JSON or Form Urlencoded content, or update a query parameter instead.' });
              }
              if (!isPlainObject(state.data)) state.data = {};
              (state.data as JsonObject)[name] = value as JsonObject[string];
            } else state.url.searchParams.set(name, text(value));
          }
        } else if (page > 0) {
          const next = template(ctx.getRawParameter('nextURL'), extra);
          if (next === undefined || next === null || String(next).trim() === '') break;
          let target: URL;
          try {
            target = new URL(String(next), state.url);
          } catch {
            throw new NodeOperationError(`Pagination: "${redact(String(next), auth.secrets)}" is not a URL`, { itemIndex: i, hint: 'The "Next URL" expression must give the address of the next page.' });
          }
          parseUrl(target.toString());
          // The API key of a "query" credential also goes on the next page of the same server.
          if (target.host === state.url.host) for (const [k, v] of auth.query) target.searchParams.set(k, v);
          state.url = target;
        }
        if (page > 0 && interval > 0) await sleep(interval, ctx.signal);

        const result = await send();
        if (completeWhen === 'receiveSpecificStatusCodes' && doneCodes.includes(result.statusCode)) break;
        if (result.statusCode >= 400 && options.neverError !== true) throw fail(statusError(result, auth.secrets, auth));
        const parsed = parseBody(result, response.format, i);
        last = { body: parsed.value, headers: result.headers, statusCode: result.statusCode, statusMessage: result.statusMessage };
        if (completeWhen === 'responseIsEmpty' && isEmptyBody(parsed.value, result)) break;
        items.push(...(await toItems(ctx, i, result, parsed, response)));
        if (completeWhen === 'other') {
          let finished: unknown;
          try {
            finished = template(ctx.getRawParameter('completeExpression'), { $pageCount: page + 1, $response: last });
          } catch (err) {
            throw new NodeOperationError(`Pagination: the complete expression failed: ${err instanceof Error ? err.message : String(err)}`, { itemIndex: i, hint: 'It must give true or false, e.g. {{ $response.body.items.length === 0 }}.' });
          }
          if (finished === true || finished === 'true') break;
        }
      }
      return items;
    });
    return [out];
  },
});
