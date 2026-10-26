// Telegram Trigger. Bot API docs: https://core.telegram.org/bots/api#getupdates
// All active workflows (and test listeners) that use the same bot share ONE long-poll loop (TelegramHub).
import type { JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { IntegrationError, toNodeError } from '../../integrations/errors.js';
import { telegramAuthFrom } from '../../integrations/telegram.js';
import { telegramHub, type TelegramUpdate } from '../../integrations/telegram-hub.js';

const COMMAND = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/;
const MESSAGE_KEYS = ['message', 'edited_message', 'channel_post', 'edited_channel_post'] as const;

const asObject = (v: unknown): JsonObject | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : undefined);
const ids = (list: string) =>
  new Set(
    list
      .split(/[,;\s]+/)
      .map((v) => v.trim())
      .filter(Boolean),
  );

/** The update type ("message", "callback_query"…): the one key besides update_id. */
function updateType(update: TelegramUpdate): string {
  return Object.keys(update).find((k) => k !== 'update_id') ?? '';
}

/** Raw update + the fields workflows need most: chatId, text, command, args. */
export function updateToItem(update: TelegramUpdate): { json: JsonObject; chatId?: string; userId?: string } {
  let chatId: unknown;
  let userId: unknown;
  let text: unknown;
  const callback = asObject(update.callback_query);
  if (callback) {
    chatId = asObject(asObject(callback.message)?.chat)?.id;
    userId = asObject(callback.from)?.id;
    text = callback.data;
  } else {
    const key = MESSAGE_KEYS.find((k) => asObject(update[k]));
    const message = key ? asObject(update[key]) : undefined;
    chatId = asObject(message?.chat)?.id;
    userId = asObject(message?.from)?.id;
    text = message?.text ?? message?.caption;
  }
  const json: JsonObject = { ...(update as JsonObject), chatId: (chatId ?? null) as JsonObject[string], text: typeof text === 'string' ? text : '' };
  if (!callback && typeof text === 'string') {
    const match = COMMAND.exec(text.trim());
    if (match) {
      json.command = match[1]!;
      json.args = (match[2] ?? '').trim();
    }
  }
  return { json, chatId: chatId === undefined ? undefined : String(chatId), userId: userId === undefined ? undefined : String(userId) };
}

export default defineNode({
  description: {
    type: 'flowforge.telegramTrigger',
    displayName: 'Telegram Trigger',
    description: 'Starts the workflow when your Telegram bot receives a message, a command or a button press.',
    icon: 'lucide:send',
    group: 'trigger',
    version: 1,
    defaults: { name: 'Telegram Trigger', color: '#2aabee' },
    subtitle: '{{updates}}',
    inputs: [],
    outputs: [{ type: 'main' }],
    trigger: { kind: 'listener' },
    credentials: [{ type: 'telegramApi', required: true }],
    keywords: ['telegram', 'bot', 'message', 'command', 'chat', 'callback', 'button'],
  },
  properties: [
    {
      name: 'updates',
      displayName: 'Trigger On',
      type: 'multiOptions',
      default: ['message'],
      options: [
        { name: 'Message', value: 'message', description: 'A new message or command sent to the bot' },
        { name: 'Edited Message', value: 'edited_message' },
        { name: 'Channel Post', value: 'channel_post', description: 'A post in a channel where the bot is administrator' },
        { name: 'Callback Query', value: 'callback_query', description: 'A press on an inline keyboard button' },
        { name: 'Any Update', value: '*' },
      ],
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add filter',
      options: [
        { name: 'command', displayName: 'Only Command', type: 'string', default: '', placeholder: '/weather', description: 'Only messages starting with this command. /weather@YourBot is accepted too.' },
        { name: 'chatIds', displayName: 'Only Chat IDs', type: 'string', default: '', placeholder: '123456789, -1001234567890', description: 'Comma-separated allow list.' },
        { name: 'userIds', displayName: 'Only User IDs', type: 'string', default: '', placeholder: '123456789', description: 'Comma-separated allow list.' },
      ],
    },
  ],
  validate(ctx) {
    const updates = ctx.getNodeParameter<string[]>('updates', ['message']);
    if (!Array.isArray(updates) || !updates.length) throw new NodeOperationError('Choose at least one update to trigger on', { hint: 'Message is the usual choice.' });
    const command = String(ctx.getNodeParameter('options.command', '') ?? '').trim();
    if (command && !/^\/?[A-Za-z0-9_]{1,32}$/.test(command)) {
      throw new NodeOperationError(`"${command}" is not a valid command`, { hint: 'A command is made of letters, digits and underscores, such as /weather.' });
    }
  },
  async trigger(ctx) {
    const credential = ctx.getCredentials('telegramApi');
    const { token, baseUrl } = telegramAuthFrom(credential.data);
    const wanted = new Set(ctx.getNodeParameter<string[]>('updates', ['message']));
    const command = String(ctx.getNodeParameter('options.command', '') ?? '')
      .trim()
      .replace(/^\//, '')
      .toLowerCase();
    const chatIds = ids(String(ctx.getNodeParameter('options.chatIds', '') ?? ''));
    const userIds = ids(String(ctx.getNodeParameter('options.userIds', '') ?? ''));
    const isTest = ctx.mode === 'manual';
    const staticData = ctx.getStaticData();
    const stored = Number(staticData.offset);

    const onUpdate = (update: TelegramUpdate) => {
      if (!wanted.has('*') && !wanted.has(updateType(update))) return;
      const { json, chatId, userId } = updateToItem(update);
      if (command && String(json.command ?? '').toLowerCase() !== command) return;
      if (chatIds.size && !(chatId && chatIds.has(chatId))) return;
      if (userIds.size && !(userId && userIds.has(userId))) return;
      ctx.emit([{ json }]);
    };

    try {
      const handle = await telegramHub.subscribe({
        token,
        baseUrl,
        startOffset: !isTest && Number.isFinite(stored) && stored > 0 ? stored : undefined,
        skipBacklog: true,
        onOffset: (offset) => {
          if (isTest) return;
          staticData.offset = offset;
          ctx.saveStaticData();
        },
        onError: (err) => {
          const hint = err instanceof IntegrationError ? err.hint : undefined;
          ctx.emitError(hint ? new Error(`${err.message}. ${hint}`) : err);
        },
        onUpdate,
      });
      return { close: () => handle.close() };
    } catch (err) {
      throw toNodeError(err, { credentialType: 'telegramApi', credential, envVars: 'TELEGRAM_BOT_TOKEN', docsAnchor: '#telegram' });
    }
  },
});
