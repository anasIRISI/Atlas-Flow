import type { Item, JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode, type WebhookResponse } from '../../engine/types.js';

export default defineNode({
  description: {
    type: 'flowforge.respondToWebhook',
    displayName: 'Respond to Webhook',
    description: "Sends the HTTP response of a webhook whose 'Respond' option is set to use this node.",
    icon: 'lucide:reply',
    group: 'network',
    version: 1,
    defaults: { name: 'Respond to Webhook', color: '#1f8eef' },
    subtitle: '{{respondWith}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['http', 'response', 'reply', 'api', 'return'],
  },
  properties: [
    {
      name: 'respondWith',
      displayName: 'Respond With',
      type: 'options',
      default: 'firstIncomingItem',
      options: [
        { name: 'All Incoming Items', value: 'allIncomingItems' },
        { name: 'First Incoming Item', value: 'firstIncomingItem' },
        { name: 'JSON', value: 'json' },
        { name: 'Text', value: 'text' },
        { name: 'Binary File', value: 'binary' },
        { name: 'Redirect', value: 'redirect' },
        { name: 'No Data', value: 'noData' },
      ],
    },
    {
      name: 'responseBody',
      displayName: 'Response Body',
      type: 'json',
      default: '{\n  "myField": "value"\n}',
      displayOptions: { show: { respondWith: ['json'] } },
    },
    {
      name: 'responseText',
      displayName: 'Response Body',
      type: 'string',
      default: '',
      typeOptions: { rows: 4 },
      displayOptions: { show: { respondWith: ['text'] } },
    },
    { name: 'redirectURL', displayName: 'Redirect URL', type: 'string', default: '', placeholder: 'https://example.com', displayOptions: { show: { respondWith: ['redirect'] } } },
    { name: 'inputDataFieldName', displayName: 'Binary Property', type: 'string', default: 'data', displayOptions: { show: { respondWith: ['binary'] } } },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'responseCode', displayName: 'Response Code', type: 'number', default: 200, typeOptions: { minValue: 100, maxValue: 599 } },
        { name: 'responseHeaders', displayName: 'Response Headers', type: 'keyValue', default: [] },
      ],
    },
  ],
  async execute(ctx) {
    const items = ctx.getInputData();
    const respondWith = ctx.getNodeParameter<string>('respondWith', 0);
    const statusCode = Number(ctx.getNodeParameter('options.responseCode', 0, 200)) || 200;
    const headers = Object.fromEntries(
      ctx
        .getNodeParameter<Array<{ name?: string; value?: unknown }>>('options.responseHeaders', 0, [])
        .filter((h) => h?.name)
        .map((h) => [String(h.name), String(h.value ?? '')]),
    );
    const response: WebhookResponse = { statusCode, headers };
    switch (respondWith) {
      case 'allIncomingItems':
        response.body = items.map((i: Item) => i.json);
        break;
      case 'firstIncomingItem':
        response.body = items[0]?.json ?? {};
        break;
      case 'json': {
        let body = ctx.getNodeParameter<unknown>('responseBody', 0);
        if (typeof body === 'string') {
          try {
            body = JSON.parse(body);
          } catch (err) {
            throw new NodeOperationError('The response body is not valid JSON', { description: (err as Error).message });
          }
        }
        response.body = body as JsonObject;
        break;
      }
      case 'text':
        response.body = String(ctx.getNodeParameter('responseText', 0, '') ?? '');
        break;
      case 'binary': {
        const field = ctx.getNodeParameter<string>('inputDataFieldName', 0, 'data');
        const ref = items[0]?.binary?.[field];
        if (!ref) throw new NodeOperationError(`No binary data in property "${field}" of the first item`);
        response.body = await ctx.helpers.getBinaryDataBuffer(0, field);
        response.headers = { 'content-type': ref.mimeType, ...(ref.fileName ? { 'content-disposition': `inline; filename="${ref.fileName.replace(/"/g, '')}"` } : {}), ...headers };
        break;
      }
      case 'redirect': {
        const url = String(ctx.getNodeParameter('redirectURL', 0, '') ?? '');
        if (!url) throw new NodeOperationError('Enter the URL to redirect to');
        response.redirect = url;
        response.statusCode = statusCode >= 300 && statusCode < 400 ? statusCode : 307;
        break;
      }
      default:
        break; // noData
    }
    if (!ctx.sendWebhookResponse(response)) {
      ctx.addLog('No webhook caller is waiting for a response (the workflow was not started by a webhook in "Respond to Webhook" mode).');
    }
    return [items];
  },
});
