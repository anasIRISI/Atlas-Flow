// Discord node (webhook only). Client + official docs URLs: server/src/integrations/discord.ts
import type { JsonObject } from '@flowforge/shared';
import { defineNode, type ExecuteContext } from '../../engine/types.js';
import {
  buildEmbed,
  deleteWebhookMessage,
  DISCORD_LIMITS,
  editWebhookMessage,
  executeWebhook,
  getWebhookMessage,
  parseWebhookUrl,
  type CallOptions,
  type Embed,
} from '../../integrations/discord.js';
import { toNodeError } from '../../integrations/errors.js';

const messageOps = { show: { operation: ['sendMessage', 'editMessage'] } };
const needsId = { show: { operation: ['editMessage', 'deleteMessage', 'getMessage'] } };

function embedsFor(ctx: ExecuteContext, i: number): Embed[] {
  const list = ctx.getNodeParameter<Array<Record<string, unknown>>>('embeds.embed', i, []);
  const out: Embed[] = [];
  for (const e of Array.isArray(list) ? list : []) {
    const mode = String(e.timestamp ?? 'none');
    const embed = buildEmbed({
      ...e,
      timestamp: mode === 'now' ? new Date() : mode === 'custom' ? e.timestampValue : undefined,
      fields: e.fieldsJson,
    });
    if (embed) out.push(embed);
  }
  return out;
}

export default defineNode({
  description: {
    type: 'flowforge.discord',
    displayName: 'Discord',
    description: 'Sends, edits, deletes or reads a message in a Discord channel through a webhook (text, embeds, threads).',
    icon: 'lucide:message-circle-more',
    group: 'integration',
    version: 1,
    defaults: { name: 'Discord', color: '#5865F2' },
    subtitle: '{{operation}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ type: 'discordWebhookApi', required: true }],
    keywords: ['discord', 'webhook', 'message', 'embed', 'chat', 'notification', 'channel'],
  },
  properties: [
    {
      name: 'operation',
      displayName: 'Operation',
      type: 'options',
      default: 'sendMessage',
      noDataExpression: true,
      options: [
        { name: 'Send Message', value: 'sendMessage', description: 'Post a message (text and/or embeds) to the channel' },
        { name: 'Edit Message', value: 'editMessage', description: 'Change a message this webhook sent earlier' },
        { name: 'Delete Message', value: 'deleteMessage', description: 'Delete a message this webhook sent earlier' },
        { name: 'Get Message', value: 'getMessage', description: 'Read a message this webhook sent earlier' },
      ],
    },
    {
      name: 'messageId',
      displayName: 'Message ID',
      type: 'string',
      default: '',
      required: true,
      placeholder: '{{ $json.id }}',
      description: 'The "id" returned by Send Message (the webhook must have sent the message).',
      displayOptions: needsId,
    },
    {
      name: 'content',
      displayName: 'Message',
      type: 'string',
      default: '',
      typeOptions: { rows: 4 },
      placeholder: 'Hello from FlowForge!',
      description: `Up to ${DISCORD_LIMITS.content} characters. Markdown works (**bold**, \`code\`).`,
      displayOptions: messageOps,
    },
    {
      name: 'embeds',
      displayName: 'Embeds',
      type: 'fixedCollection',
      default: {},
      placeholder: 'Add embed',
      description: `Rich cards under the message. At most ${DISCORD_LIMITS.embeds} embeds and ${DISCORD_LIMITS.totalEmbedChars} characters in total.`,
      typeOptions: { multipleValues: true },
      displayOptions: messageOps,
      options: [
        {
          name: 'embed',
          displayName: 'Embed',
          values: [
            { name: 'title', displayName: 'Title', type: 'string', default: '', description: `Up to ${DISCORD_LIMITS.title} characters.` },
            { name: 'description', displayName: 'Description', type: 'string', default: '', typeOptions: { rows: 3 }, description: `Up to ${DISCORD_LIMITS.description} characters.` },
            { name: 'url', displayName: 'Title URL', type: 'string', default: '', placeholder: 'https://…', description: 'Makes the title a link.' },
            { name: 'color', displayName: 'Color', type: 'color', default: '#5865F2' },
            { name: 'authorName', displayName: 'Author Name', type: 'string', default: '' },
            { name: 'authorUrl', displayName: 'Author URL', type: 'string', default: '' },
            { name: 'authorIconUrl', displayName: 'Author Icon URL', type: 'string', default: '' },
            { name: 'thumbnailUrl', displayName: 'Thumbnail URL', type: 'string', default: '', description: 'Small image at the top right.' },
            { name: 'imageUrl', displayName: 'Image URL', type: 'string', default: '', description: 'Large image at the bottom.' },
            { name: 'footerText', displayName: 'Footer Text', type: 'string', default: '' },
            { name: 'footerIconUrl', displayName: 'Footer Icon URL', type: 'string', default: '' },
            {
              name: 'timestamp',
              displayName: 'Timestamp',
              type: 'options',
              default: 'none',
              noDataExpression: true,
              options: [
                { name: 'None', value: 'none' },
                { name: 'Now', value: 'now' },
                { name: 'Custom', value: 'custom' },
              ],
            },
            {
              name: 'timestampValue',
              displayName: 'Timestamp Value',
              type: 'string',
              default: '',
              placeholder: '2026-10-12T09:30:00Z',
              description: 'ISO 8601 date.',
              displayOptions: { show: { timestamp: ['custom'] } },
            },
            {
              name: 'fieldsJson',
              displayName: 'Fields (JSON)',
              type: 'json',
              default: '[]',
              description: `List of up to ${DISCORD_LIMITS.fields} fields: [{ "name": "Status", "value": "OK", "inline": true }].`,
            },
          ],
        },
      ],
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      description: 'Username, avatar, tts and the suppress flags apply to Send Message; Thread ID and Timeout to every operation.',
      options: [
        { name: 'username', displayName: 'Username', type: 'string', default: '', description: 'Overrides the name of the webhook for this message.' },
        { name: 'avatarUrl', displayName: 'Avatar URL', type: 'string', default: '', description: 'Overrides the picture of the webhook for this message.' },
        { name: 'tts', displayName: 'Text To Speech', type: 'boolean', default: false },
        { name: 'threadId', displayName: 'Thread ID', type: 'string', default: '', description: 'Send to (or edit / delete in) a thread of the channel.' },
        { name: 'suppressEmbeds', displayName: 'Suppress Embeds', type: 'boolean', default: false, description: 'Do not show link previews and embeds.' },
        { name: 'suppressNotifications', displayName: 'Suppress Notifications', type: 'boolean', default: false, description: 'The message does not notify anyone.' },
        { name: 'wait', displayName: 'Wait For Message', type: 'boolean', default: true, description: 'On: the output is the full message (with its id, needed to edit or delete it later). Off: the output is just { success: true }.' },
        {
          name: 'longContent',
          displayName: 'Long Content',
          type: 'options',
          default: 'error',
          options: [
            { name: 'Fail With An Error', value: 'error' },
            { name: 'Truncate', value: 'truncate', description: `Cut the message at ${DISCORD_LIMITS.content} characters, ending with …` },
          ],
        },
        { name: 'timeout', displayName: 'Timeout (Seconds)', type: 'number', default: 30, typeOptions: { minValue: 1, maxValue: 300 } },
      ],
    },
  ],
  /** Demo Mode: what Discord would answer (nothing is posted). */
  simulate(ctx, _item, i) {
    return { id: 'simulated', content: String(ctx.getNodeParameter('content', i, '') ?? ''), channel_id: 'simulated' };
  },

  async execute(ctx) {
    const credential = await ctx.getCredentials('discordWebhookApi');
    const rejected = (err: unknown, itemIndex: number) =>
      toNodeError(err, { credentialType: 'discordWebhookApi', credential, envVars: 'DISCORD_WEBHOOK_URL', docsAnchor: '#discord', itemIndex });

    const out = await ctx.forEachItem(async (_item, i) => {
      try {
        const target = parseWebhookUrl(credential.data.webhookUri);
        const operation = String(ctx.getNodeParameter('operation', i, 'sendMessage'));
        const options = ctx.getNodeParameter<JsonObject>('options', i, {});
        const call: CallOptions = { signal: ctx.signal, timeoutMs: Math.min(Math.max(Number(options.timeout ?? 30) || 30, 1), 300) * 1000 };
        const threadId = String(options.threadId ?? '').trim() || undefined;
        const messageId = () => String(ctx.getNodeParameter('messageId', i, ''));

        if (operation === 'deleteMessage') {
          const id = messageId();
          await deleteWebhookMessage(target, id, { threadId }, call);
          return { json: { success: true, messageId: id.trim() } };
        }
        if (operation === 'getMessage') return { json: await getWebhookMessage(target, messageId(), { threadId }, call) };

        let content = String(ctx.getNodeParameter('content', i, '') ?? '');
        if (content.length > DISCORD_LIMITS.content && options.longContent === 'truncate') content = `${content.slice(0, DISCORD_LIMITS.content - 1)}…`;
        const embeds = embedsFor(ctx, i);
        if (operation === 'editMessage') {
          return { json: await editWebhookMessage(target, messageId(), { content: content || undefined, embeds: embeds.length ? embeds : undefined, threadId }, call) };
        }
        return {
          json: await executeWebhook(
            target,
            {
              content,
              embeds,
              username: String(options.username ?? ''),
              avatarUrl: String(options.avatarUrl ?? ''),
              tts: options.tts === true,
              suppressEmbeds: options.suppressEmbeds === true,
              suppressNotifications: options.suppressNotifications === true,
              threadId,
              wait: options.wait !== false,
            },
            call,
          ),
        };
      } catch (err) {
        throw rejected(err, i);
      }
    });
    return [out];
  },
});
