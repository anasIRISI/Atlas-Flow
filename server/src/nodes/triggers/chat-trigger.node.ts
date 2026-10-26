import { randomUUID } from 'node:crypto';
import type { JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { getPath } from '../../engine/params.js';
import { defineNode, type WebhookHandleResult } from '../../engine/types.js';
import { chatReply, cleanSessionId, MAX_CHAT_INPUT_CHARS, renderChatPage } from '../_shared/chat-page.js';

const json = (statusCode: number, body: JsonObject) => ({ response: { statusCode, body } });

export default defineNode({
  description: {
    type: 'flowforge.chatTrigger',
    displayName: 'Chat Trigger',
    description: 'A chat page for phones and computers (and a chat panel in the editor): each message starts the workflow, the last node answers.',
    icon: 'lucide:messages-square',
    group: 'trigger',
    version: 1,
    defaults: { name: 'When chat message received', color: '#3fb8af' },
    subtitle: '{{title}}',
    inputs: [],
    outputs: [{ type: 'main' }],
    trigger: { kind: 'webhook' },
    keywords: ['chat', 'chatbot', 'assistant', 'message', 'conversation', 'ai', 'bot'],
  },
  properties: [
    { name: 'chatUrls', displayName: 'Chat URL', type: 'webhookUrls', default: '', typeOptions: { urlPrefix: 'chat' } },
    { name: 'title', displayName: 'Title', type: 'string', default: 'Chat', placeholder: 'e.g. Shop assistant' },
    { name: 'subtitle', displayName: 'Subtitle', type: 'string', default: 'Ask me anything.' },
    {
      name: 'initialMessages',
      displayName: 'Initial Messages',
      type: 'string',
      default: 'Hi there! 👋\nHow can I help you today?',
      typeOptions: { rows: 3 },
      description: 'Greeting shown before the first message. One bubble per line.',
    },
    {
      name: 'replyNotice',
      displayName: 'The reply is the output of the last node: its "output" or "text" field (Google Gemini returns "text").',
      type: 'notice',
      default: '',
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'path', displayName: 'Chat Path', type: 'string', default: '', placeholder: 'e.g. support', description: 'Readable URL such as /chat/support. Empty = a random id.', noDataExpression: true },
        { name: 'inputPlaceholder', displayName: 'Input Placeholder', type: 'string', default: 'Type your message…' },
        { name: 'accentColor', displayName: 'Accent Color', type: 'color', default: '#f0592a' },
        { name: 'appendAttribution', displayName: 'Show "Powered by FlowForge"', type: 'boolean', default: true },
      ],
    },
  ],
  webhook: {
    urlPrefix: 'chat',
    endpoints(node, params) {
      return { methods: ['GET', 'POST'], path: String(getPath(params, 'options.path') || node.webhookId || node.id) };
    },
    handle({ request, parameters: p }): WebhookHandleResult {
      const options = (p.options ?? {}) as JsonObject;
      const mode = request.executionMode === 'test' ? 'test' : 'production';

      if (request.method === 'GET') {
        const html = renderChatPage({
          title: String(p.title || 'Chat'),
          subtitle: String(p.subtitle ?? ''),
          initialMessages: String(p.initialMessages ?? '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          placeholder: String(options.inputPlaceholder || 'Type your message…'),
          accent: String(options.accentColor || '#f0592a'),
          attribution: options.appendAttribution !== false,
          action: request.requestPath,
          mode,
        });
        return { response: { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: html } };
      }

      const body = (request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {}) as JsonObject;
      const chatInput = typeof body.chatInput === 'string' ? body.chatInput.trim() : '';
      if (!chatInput) return json(400, { message: 'The message is empty. Send JSON such as {"chatInput": "Hello", "sessionId": "abc"}.' });
      if (chatInput.length > MAX_CHAT_INPUT_CHARS) return json(400, { message: `The message is too long (${chatInput.length} characters, the limit is ${MAX_CHAT_INPUT_CHARS}).` });
      const sessionId = cleanSessionId(body.sessionId) ?? randomUUID();

      return {
        items: [{ json: { sessionId, action: 'sendMessage', chatInput } }],
        responseMode: 'lastNode',
        complete: (outcome) => {
          if (outcome.finished && outcome.status === 'success') return { statusCode: 200, body: { output: chatReply(outcome.items), sessionId } };
          // Visitors get a generic message; the editor's test chat shows the real error to the builder.
          const detail = outcome.finished && outcome.error ? outcome.error : 'The workflow did not finish.';
          return { statusCode: 500, body: { message: mode === 'test' ? `The workflow failed: ${detail}` : 'Sorry, something went wrong. Please try again in a moment.', sessionId } };
        },
      };
    },
  },
  execute() {
    throw new NodeOperationError('This node waits for a chat message', {
      hint: 'Open the Chat panel of the editor and send a message, or pin some data on this node.',
    });
  },
});
