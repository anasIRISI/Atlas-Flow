import type { JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { isPlainObject } from '../_shared/fields.js';
import { HTTP_AUTH_CREDENTIALS, HTTP_AUTH_PROPERTY, httpSend, parseUrl, redact, resolveHttpAuth, statusError } from '../_shared/http-client.js';
import { jsonValue, keyValuePairs } from './http-request.node.js';

export default defineNode({
  description: {
    type: 'flowforge.graphql',
    displayName: 'GraphQL',
    description: 'Sends a GraphQL query or mutation with variables and returns the answer.',
    icon: 'lucide:waypoints',
    group: 'network',
    version: 1,
    defaults: { name: 'GraphQL', color: '#e535ab' },
    subtitle: '{{requestMethod}} {{endpoint}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: HTTP_AUTH_CREDENTIALS,
    keywords: ['graphql', 'api', 'query', 'mutation', 'request', 'http'],
  },
  properties: [
    { name: 'endpoint', displayName: 'Endpoint', type: 'string', default: '', required: true, placeholder: 'https://countries.trevorblades.com/' },
    HTTP_AUTH_PROPERTY,
    {
      name: 'requestMethod',
      displayName: 'HTTP Request Method',
      type: 'options',
      default: 'POST',
      options: [
        { name: 'POST', value: 'POST' },
        { name: 'GET', value: 'GET', description: 'The query travels in the URL' },
      ],
    },
    {
      name: 'query',
      displayName: 'Query',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { rows: 8 },
      placeholder: 'query ($code: ID!) {\n  country(code: $code) {\n    name\n    capital\n  }\n}',
    },
    { name: 'variables', displayName: 'Variables', type: 'json', default: '{}', description: 'Values of the $variables of the query, as JSON.' },
    { name: 'operationName', displayName: 'Operation Name', type: 'string', default: '', description: 'Only needed when the query text contains several operations.' },
    { name: 'headerParameters', displayName: 'Headers', type: 'keyValue', default: [] },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'timeout', displayName: 'Timeout (ms)', type: 'number', default: 10000, typeOptions: { minValue: 1, maxValue: 3600000 } },
        { name: 'allowUnauthorizedCerts', displayName: 'Ignore SSL Issues', type: 'boolean', default: false },
        { name: 'ignoreGraphqlErrors', displayName: 'Do Not Fail On GraphQL Errors', type: 'boolean', default: false, description: 'Output the answer with its "errors" list instead of failing.' },
      ],
    },
  ],
  async execute(ctx) {
    const auth = await resolveHttpAuth(ctx, ctx.getNodeParameter('authentication', 0, 'none'));
    const out = await ctx.forEachItem(async (_item, i) => {
      const options = ctx.getNodeParameter<JsonObject>('options', i, {});
      const url = parseUrl(ctx.getNodeParameter('endpoint', i, ''));
      const query = String(ctx.getNodeParameter('query', i, '') ?? '').trim();
      if (!query) throw new NodeOperationError('The GraphQL query is empty', { itemIndex: i, hint: 'Example: { country(code: "FR") { name capital } }' });
      const variables = jsonValue(ctx.getNodeParameter('variables', i, '{}'), 'Variables', i);
      if (!isPlainObject(variables)) throw new NodeOperationError('Variables must be a JSON object, e.g. {"code": "FR"}', { itemIndex: i });
      const operationName = String(ctx.getNodeParameter('operationName', i, '') ?? '').trim();
      const method = ctx.getNodeParameter<string>('requestMethod', i, 'POST') === 'GET' ? 'GET' : 'POST';
      const headers: Record<string, string> = { 'user-agent': 'FlowForge/0.1', accept: 'application/json' };
      for (const [k, v] of keyValuePairs(ctx.getNodeParameter('headerParameters', i, []))) headers[k.toLowerCase()] = v;
      Object.assign(headers, auth.headers);
      for (const [k, v] of auth.query) url.searchParams.set(k, v);

      let body: string | undefined;
      if (method === 'GET') {
        url.searchParams.set('query', query);
        if (Object.keys(variables).length) url.searchParams.set('variables', JSON.stringify(variables));
        if (operationName) url.searchParams.set('operationName', operationName);
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify({ query, variables, ...(operationName ? { operationName } : {}) });
      }

      const result = await httpSend({
        method,
        url: url.toString(),
        headers,
        body,
        timeoutMs: Math.min(Math.max(Number(options.timeout ?? 10_000) || 10_000, 1), 3_600_000),
        followRedirects: true,
        maxRedirects: 10,
        ignoreSsl: options.allowUnauthorizedCerts === true,
        signal: ctx.signal,
        secrets: auth.secrets,
      });

      const text = result.body.toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      // GraphQL servers report query problems in "errors", often with HTTP 200 (sometimes 400).
      const errors = isPlainObject(parsed) && Array.isArray(parsed.errors) ? (parsed.errors as Array<{ message?: unknown }>) : [];
      if (errors.length && options.ignoreGraphqlErrors !== true) {
        const first = redact(String(errors[0]?.message ?? 'Unknown error'), auth.secrets);
        throw new NodeOperationError(`GraphQL error: ${first}`, {
          itemIndex: i,
          description: errors.length > 1 ? `${errors.length} errors: ${redact(errors.map((e) => String(e?.message ?? '')).join(' · ').slice(0, 800), auth.secrets)}` : undefined,
          hint: 'Check the field names and the variables of the query against the schema of the API.',
        });
      }
      if (result.statusCode >= 400 && !errors.length) {
        const err = statusError(result, auth.secrets, auth);
        err.itemIndex = i;
        throw err;
      }
      if (!isPlainObject(parsed)) {
        throw new NodeOperationError('The server did not answer with GraphQL JSON', { itemIndex: i, description: redact(text.slice(0, 300), auth.secrets), hint: 'Check that the endpoint is the GraphQL URL of the API (often ending in /graphql).' });
      }
      return { json: parsed };
    });
    return [out];
  },
});
