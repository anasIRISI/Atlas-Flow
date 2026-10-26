// Telegram node. Bot API docs: https://core.telegram.org/bots/api (sendMessage, sendPhoto, sendDocument,
// editMessageText, deleteMessage, answerCallbackQuery, getChat). The HTTP client is server/src/integrations/telegram.ts.
import type { JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode, type ExecuteContext } from '../../engine/types.js';
import { telegramAuthFrom, telegramCall, type TelegramAuth, type TelegramUpload } from '../../integrations/telegram.js';
import { toNodeError } from '../../integrations/errors.js';

const SEND_WITH_KEYBOARD = ['sendMessage', 'sendPhoto', 'sendDocument', 'editMessageText'];
const SEND_FILE = ['sendPhoto', 'sendDocument'];
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

const show = (operation: string[], extra: Record<string, unknown[]> = {}) => ({ show: { operation, ...extra } });

const present = (v: unknown) => v !== undefined && v !== null && v !== '';

function positiveInt(value: unknown, label: string, itemIndex: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new NodeOperationError(`"${label}" must be a whole number such as 42`, { itemIndex, hint: `Got "${String(value ?? '')}". The Message ID is in the output of the Telegram node that sent the message (message_id).` });
  }
  return n;
}

/** Inline keyboard from the "Inline Keyboard" buttons: rows of `buttonsPerRow`. Undefined when there is no button. */
function keyboardFor(ctx: ExecuteContext, i: number): JsonObject | undefined {
  const raw = ctx.getNodeParameter<{ buttons?: JsonObject[] }>('inlineKeyboard', i, {});
  const buttons = Array.isArray(raw?.buttons) ? raw.buttons : [];
  if (!buttons.length) return undefined;
  const perRow = Math.min(Math.max(Math.trunc(Number(ctx.getNodeParameter('buttonsPerRow', i, 2))) || 2, 1), 8);
  const built = buttons.map((b, n) => {
    const text = String(b.text ?? '').trim();
    const value = String(b.value ?? '').trim();
    const type = String(b.type ?? 'callback');
    if (!text) throw new NodeOperationError(`Button ${n + 1} has no text`, { itemIndex: i, hint: 'Every button of the inline keyboard needs a label.' });
    if (!value) throw new NodeOperationError(`Button "${text}" has no ${type === 'url' ? 'URL' : 'callback data'}`, { itemIndex: i, hint: type === 'url' ? 'Enter the address the button opens.' : 'Enter the text your workflow receives when the button is pressed.' });
    if (type === 'url') {
      try {
        new URL(value);
      } catch {
        throw new NodeOperationError(`The URL of button "${text}" is not valid`, { itemIndex: i, hint: 'Use a full address such as https://example.com.' });
      }
      return { text, url: value };
    }
    if (Buffer.byteLength(value) > 64) {
      throw new NodeOperationError(`The callback data of button "${text}" is longer than 64 bytes`, { itemIndex: i, hint: 'Telegram allows 1 to 64 bytes. Use a short code such as "approve:42".' });
    }
    return { text, callback_data: value };
  });
  const rows: JsonObject[][] = [];
  for (let n = 0; n < built.length; n += perRow) rows.push(built.slice(n, n + perRow));
  return { inline_keyboard: rows };
}

function textFor(ctx: ExecuteContext, i: number, name: string, label: string, max: number, required: boolean): string {
  const text = String(ctx.getNodeParameter(name, i, '') ?? '');
  if (required && !text.trim()) throw new NodeOperationError(`${label} is empty`, { itemIndex: i, hint: 'Enter the text, or an expression such as {{ $json.message }}.' });
  if (text.length > max) throw new NodeOperationError(`${label} is too long (${text.length} characters, Telegram allows ${max})`, { itemIndex: i, hint: 'Shorten it, or split it into several messages.' });
  return text;
}

export default defineNode({
  description: {
    type: 'flowforge.telegram',
    displayName: 'Telegram',
    description: 'Sends messages, photos and files with a Telegram bot, edits or deletes them, answers button presses.',
    icon: 'lucide:send',
    group: 'integration',
    version: 1,
    defaults: { name: 'Telegram', color: '#2aabee' },
    subtitle: '{{operation}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ type: 'telegramApi', required: true }],
    keywords: ['telegram', 'bot', 'chat', 'message', 'send', 'notification', 'photo', 'document', 'keyboard'],
  },
  properties: [
    {
      name: 'operation',
      displayName: 'Operation',
      type: 'options',
      default: 'sendMessage',
      noDataExpression: true,
      options: [
        { name: 'Send Message', value: 'sendMessage', description: 'Send a text message' },
        { name: 'Send Photo', value: 'sendPhoto', description: 'Send a picture' },
        { name: 'Send Document', value: 'sendDocument', description: 'Send a file (up to 50 MB)' },
        { name: 'Edit Message Text', value: 'editMessageText', description: 'Change the text of a message the bot sent' },
        { name: 'Delete Message', value: 'deleteMessage', description: 'Delete a message' },
        { name: 'Answer Callback Query', value: 'answerCallbackQuery', description: 'Reply to a press on an inline keyboard button' },
        { name: 'Get Chat', value: 'getChat', description: 'Get the details of a chat' },
      ],
    },
    {
      name: 'chatId',
      displayName: 'Chat ID',
      type: 'string',
      default: '',
      placeholder: '123456789',
      description: 'Empty: the Default Chat ID of the credential (TELEGRAM_CHAT_ID). Use @channelname for public channels.',
      displayOptions: { hide: { operation: ['answerCallbackQuery'] } },
    },
    {
      name: 'text',
      displayName: 'Text',
      type: 'string',
      default: '',
      required: true,
      typeOptions: { rows: 4 },
      description: '1 to 4096 characters.',
      displayOptions: show(['sendMessage', 'editMessageText']),
    },
    {
      name: 'parseMode',
      displayName: 'Parse Mode',
      type: 'options',
      default: 'none',
      description: 'How Telegram reads formatting such as <b>bold</b> (HTML) or *bold* (Markdown).',
      options: [
        { name: 'None', value: 'none' },
        { name: 'HTML', value: 'HTML' },
        { name: 'Markdown', value: 'Markdown' },
        { name: 'MarkdownV2', value: 'MarkdownV2' },
      ],
      displayOptions: show(['sendMessage', 'sendPhoto', 'sendDocument', 'editMessageText']),
    },
    {
      name: 'fileSource',
      displayName: 'File Source',
      type: 'options',
      default: 'binary',
      noDataExpression: true,
      options: [
        { name: 'Binary Data', value: 'binary', description: 'A file coming from a previous node' },
        { name: 'URL or File ID', value: 'url', description: 'An address Telegram downloads, or the file_id of a file Telegram already has' },
      ],
      displayOptions: show(SEND_FILE),
    },
    {
      name: 'binaryPropertyName',
      displayName: 'Input Binary Field',
      type: 'string',
      default: 'data',
      description: 'Name of the binary property of the input item that holds the file.',
      displayOptions: show(SEND_FILE, { fileSource: ['binary'] }),
    },
    {
      name: 'fileUrl',
      displayName: 'URL or File ID',
      type: 'string',
      default: '',
      placeholder: 'https://example.com/picture.jpg',
      displayOptions: show(SEND_FILE, { fileSource: ['url'] }),
    },
    {
      name: 'caption',
      displayName: 'Caption',
      type: 'string',
      default: '',
      description: 'Up to 1024 characters.',
      displayOptions: show(SEND_FILE),
    },
    { name: 'messageId', displayName: 'Message ID', type: 'string', default: '', required: true, placeholder: '42', displayOptions: show(['editMessageText', 'deleteMessage']) },
    { name: 'callbackQueryId', displayName: 'Callback Query ID', type: 'string', default: '', required: true, placeholder: '{{ $json.callback_query.id }}', displayOptions: show(['answerCallbackQuery']) },
    { name: 'answerText', displayName: 'Text', type: 'string', default: '', description: 'Shown to the user as a small notice (up to 200 characters). Empty: nothing is shown.', displayOptions: show(['answerCallbackQuery']) },
    { name: 'showAlert', displayName: 'Show As Alert', type: 'boolean', default: false, description: 'A popup the user has to close instead of a short notice.', displayOptions: show(['answerCallbackQuery']) },
    {
      name: 'inlineKeyboard',
      displayName: 'Inline Keyboard',
      type: 'fixedCollection',
      default: {},
      placeholder: 'Add button',
      typeOptions: { multipleValues: true },
      description: 'Buttons under the message. A callback button sends its data to your Telegram Trigger (updates: Callback Query).',
      displayOptions: show(SEND_WITH_KEYBOARD),
      options: [
        {
          name: 'buttons',
          displayName: 'Button',
          values: [
            { name: 'text', displayName: 'Label', type: 'string', default: '', placeholder: 'Approve' },
            {
              name: 'type',
              displayName: 'Type',
              type: 'options',
              default: 'callback',
              noDataExpression: true,
              options: [
                { name: 'Callback (sends data to the bot)', value: 'callback' },
                { name: 'URL (opens a link)', value: 'url' },
              ],
            },
            { name: 'value', displayName: 'Callback Data / URL', type: 'string', default: '', placeholder: 'approve:42 or https://example.com' },
          ],
        },
      ],
    },
    {
      name: 'buttonsPerRow',
      displayName: 'Buttons Per Row',
      type: 'number',
      default: 2,
      typeOptions: { minValue: 1, maxValue: 8 },
      displayOptions: show(SEND_WITH_KEYBOARD),
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'disableNotification', displayName: 'Send Silently', type: 'boolean', default: false, description: 'No sound for the receiver.' },
        { name: 'disableLinkPreview', displayName: 'Disable Link Preview', type: 'boolean', default: false, displayOptions: show(['sendMessage']) },
        { name: 'protectContent', displayName: 'Protect Content', type: 'boolean', default: false, description: 'Forwarding and saving are forbidden.' },
        { name: 'replyToMessageId', displayName: 'Reply To Message ID', type: 'string', default: '' },
        { name: 'messageThreadId', displayName: 'Thread ID', type: 'string', default: '', description: 'Topic of a group that has topics enabled.' },
        { name: 'timeout', displayName: 'Timeout (Seconds)', type: 'number', default: 30, typeOptions: { minValue: 1, maxValue: 300 } },
      ],
    },
  ],
  /** Demo Mode: what Telegram would answer (nothing is sent). */
  simulate(ctx, _item, i) {
    return { message_id: 0, chat: { id: String(ctx.getNodeParameter('chatId', i, '') ?? '') || 'simulated' }, text: String(ctx.getNodeParameter('text', i, '') ?? '') };
  },

  async execute(ctx) {
    const credential = await ctx.getCredentials('telegramApi');
    const { chatId: defaultChatId, ...auth } = telegramAuthFrom(credential.data);
    const fail = (err: unknown, itemIndex: number) => toNodeError(err, { credentialType: 'telegramApi', credential, envVars: 'TELEGRAM_BOT_TOKEN', docsAnchor: '#telegram', itemIndex });

    const sent = await ctx.forEachItem(async (_item, i) => {
      const operation = String(ctx.getNodeParameter('operation', i, 'sendMessage'));
      const options = ctx.getNodeParameter<JsonObject>('options', i, {});
      const params: Record<string, unknown> = {};
      let upload: TelegramUpload | undefined;

      if (operation !== 'answerCallbackQuery') {
        const chatId = String(ctx.getNodeParameter('chatId', i, '') ?? '').trim() || defaultChatId;
        if (!chatId) {
          throw new NodeOperationError('No chat: "Chat ID" is empty', {
            itemIndex: i,
            hint: 'Enter a Chat ID, or fill "Default Chat ID" in the Telegram credential (.env: TELEGRAM_CHAT_ID). To find yours, send /start to your bot and read message.chat.id in a Telegram Trigger.',
          });
        }
        params.chat_id = chatId;
      }

      const parseMode = String(ctx.getNodeParameter('parseMode', i, 'none'));
      const withFormatting = () => {
        if (parseMode !== 'none') params.parse_mode = parseMode;
      };
      const withOptions = (allowThread: boolean) => {
        if (options.disableNotification === true) params.disable_notification = true;
        if (options.protectContent === true) params.protect_content = true;
        if (allowThread) {
          if (present(options.replyToMessageId)) params.reply_parameters = { message_id: positiveInt(options.replyToMessageId, 'Reply To Message ID', i) };
          if (present(options.messageThreadId)) params.message_thread_id = positiveInt(options.messageThreadId, 'Thread ID', i);
        }
      };
      const withKeyboard = () => {
        const markup = keyboardFor(ctx, i);
        if (markup) params.reply_markup = markup;
      };

      switch (operation) {
        case 'sendMessage':
          params.text = textFor(ctx, i, 'text', 'The text', 4096, true);
          withFormatting();
          withOptions(true);
          if (options.disableLinkPreview === true) params.link_preview_options = { is_disabled: true };
          withKeyboard();
          break;
        case 'sendPhoto':
        case 'sendDocument': {
          const field = operation === 'sendPhoto' ? 'photo' : 'document';
          const caption = textFor(ctx, i, 'caption', 'The caption', 1024, false);
          if (String(ctx.getNodeParameter('fileSource', i, 'binary')) === 'url') {
            const url = String(ctx.getNodeParameter('fileUrl', i, '') ?? '').trim();
            if (!url) throw new NodeOperationError('"URL or File ID" is empty', { itemIndex: i, hint: 'Enter the address of the file, or the file_id of a file Telegram already has.' });
            params[field] = url;
          } else {
            const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data').trim();
            const ref = ctx.getInputData()[i]?.binary?.[property];
            if (!ref) {
              throw new NodeOperationError(`Item ${i} has no binary property "${property}"`, {
                itemIndex: i,
                hint: `Binary properties of this item: ${Object.keys(ctx.getInputData()[i]?.binary ?? {}).join(', ') || 'none'}. Read or download the file in a previous node, or set File Source to "URL or File ID".`,
              });
            }
            const data = await ctx.helpers.getBinaryDataBuffer(i, property);
            const limit = field === 'photo' ? MAX_PHOTO_BYTES : MAX_DOCUMENT_BYTES;
            if (data.length > limit) {
              throw new NodeOperationError(`The file is too big for Telegram (${Math.round(data.length / 1024 / 1024)} MB, the limit is ${limit / 1024 / 1024} MB)`, {
                itemIndex: i,
                hint: field === 'photo' ? 'Photos are limited to 10 MB: send it as a document instead.' : 'Telegram bots can send files up to 50 MB.',
              });
            }
            upload = { field, data, fileName: ref.fileName ?? property, mimeType: ref.mimeType };
          }
          if (caption) params.caption = caption;
          if (caption) withFormatting();
          withOptions(true);
          withKeyboard();
          break;
        }
        case 'editMessageText':
          params.message_id = positiveInt(ctx.getNodeParameter('messageId', i, ''), 'Message ID', i);
          params.text = textFor(ctx, i, 'text', 'The text', 4096, true);
          withFormatting();
          withKeyboard();
          break;
        case 'deleteMessage':
          params.message_id = positiveInt(ctx.getNodeParameter('messageId', i, ''), 'Message ID', i);
          break;
        case 'answerCallbackQuery': {
          const id = String(ctx.getNodeParameter('callbackQueryId', i, '') ?? '').trim();
          if (!id) throw new NodeOperationError('"Callback Query ID" is empty', { itemIndex: i, hint: 'Use {{ $json.callback_query.id }} from a Telegram Trigger that listens to Callback Query.' });
          params.callback_query_id = id;
          const text = textFor(ctx, i, 'answerText', 'The text', 200, false);
          if (text) params.text = text;
          if (ctx.getNodeParameter<boolean>('showAlert', i, false) === true) params.show_alert = true;
          break;
        }
        case 'getChat':
          break;
        default:
          throw new NodeOperationError(`Unknown operation "${operation}"`, { itemIndex: i });
      }

      const timeoutMs = Math.min(Math.max(Number(options.timeout ?? 30) || 30, 1), 300) * 1000;
      try {
        const result = await telegramCall<unknown>(auth as TelegramAuth, operation as Parameters<typeof telegramCall>[1], params, { signal: ctx.signal, timeoutMs, upload });
        return { json: result !== null && typeof result === 'object' && !Array.isArray(result) ? (result as JsonObject) : { success: result === true } };
      } catch (err) {
        throw fail(err, i);
      }
    });
    return [sent];
  },
});
