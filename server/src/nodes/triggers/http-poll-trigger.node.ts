import type { Item, JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { getPath } from '../../engine/params.js';
import { defineNode } from '../../engine/types.js';
import { dedupe } from '../../triggers/dedupe.js';
import { assertHttpUrl, fetchWithTimeout } from '../_shared/http.js';

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

export default defineNode({
  description: {
    type: 'flowforge.httpPollTrigger',
    displayName: 'HTTP Poll Trigger',
    description: 'Calls a JSON API at an interval and starts the workflow for each new item.',
    icon: 'lucide:radar',
    group: 'trigger',
    version: 1,
    defaults: { name: 'HTTP Poll Trigger', color: '#2c8ee8' },
    subtitle: 'every {{pollInterval}} {{pollUnit}}',
    inputs: [],
    outputs: [{ type: 'main' }],
    trigger: { kind: 'poll' },
    keywords: ['api', 'poll', 'json', 'check', 'watch', 'new items'],
  },
  properties: [
    { name: 'url', displayName: 'URL', type: 'string', default: '', placeholder: 'https://api.example.com/orders', required: true },
    {
      name: 'method',
      displayName: 'Method',
      type: 'options',
      default: 'GET',
      options: [
        { name: 'GET', value: 'GET' },
        { name: 'POST', value: 'POST' },
      ],
    },
    { name: 'headers', displayName: 'Headers', type: 'keyValue', default: [] },
    { name: 'body', displayName: 'JSON Body', type: 'json', default: '{}', displayOptions: { show: { method: ['POST'] } } },
    {
      name: 'itemsPath',
      displayName: 'Items Path',
      type: 'string',
      default: '',
      placeholder: 'e.g. data.items',
      description: 'Where the list is in the response. Empty = the response itself.',
    },
    {
      name: 'dedupeKey',
      displayName: 'Unique Field',
      type: 'string',
      default: '',
      placeholder: 'e.g. id',
      description: 'Field that identifies an item. Empty = compare whole items (SHA-256).',
    },
    { name: 'pollInterval', displayName: 'Check Every', type: 'number', default: 1, typeOptions: { minValue: 1 } },
    {
      name: 'pollUnit',
      displayName: 'Unit',
      type: 'options',
      default: 'minutes',
      options: [
        { name: 'Seconds', value: 'seconds' },
        { name: 'Minutes', value: 'minutes' },
        { name: 'Hours', value: 'hours' },
      ],
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          name: 'emitExistingOnFirstRun',
          displayName: 'Emit Existing Items on First Check',
          type: 'boolean',
          default: false,
          description: 'Off = the first check only remembers what is already there.',
        },
      ],
    },
  ],
  validate(ctx) {
    assertHttpUrl(String(ctx.getNodeParameter('url', '') ?? ''));
  },
  async poll(ctx) {
    const url = String(ctx.getNodeParameter('url', '') ?? '');
    const method = String(ctx.getNodeParameter('method', 'GET'));
    const headers = Object.fromEntries(
      ctx
        .getNodeParameter<Array<{ name?: string; value?: unknown }>>('headers', [])
        .filter((h) => h?.name)
        .map((h) => [String(h.name), String(h.value ?? '')]),
    );
    let body: string | undefined;
    if (method === 'POST') {
      const raw = ctx.getNodeParameter<unknown>('body', '{}');
      body = typeof raw === 'string' ? raw : JSON.stringify(raw);
      headers['content-type'] ??= 'application/json';
    }
    const res = await fetchWithTimeout(url, { method, headers, body });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new NodeOperationError('The response is not JSON', { hint: 'This trigger expects a JSON API.' });
    }
    const path = String(ctx.getNodeParameter('itemsPath', '') ?? '').trim();
    const list = path ? getPath(data, path) : data;
    if (path && list === undefined) throw new NodeOperationError(`Nothing found at "${path}" in the response`);
    const items: Item[] = (Array.isArray(list) ? list : [list]).map((v) => ({ json: isObject(v) ? v : { value: v } }));
    if (ctx.mode === 'manual') return items.slice(0, 50);
    return dedupe(ctx.getStaticData(), items, {
      key: String(ctx.getNodeParameter('dedupeKey', '') ?? '').trim() || undefined,
      emitExistingOnFirstRun: ctx.getNodeParameter<boolean>('options.emitExistingOnFirstRun', false),
    });
  },
});
