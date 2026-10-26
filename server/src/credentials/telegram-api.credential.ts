import { IntegrationError } from '../integrations/errors.js';
import { getMe, telegramAuthFrom } from '../integrations/telegram.js';
import { defineCredential } from './types.js';

export default defineCredential({
  name: 'telegramApi',
  displayName: 'Telegram Bot',
  description: 'A bot token from @BotFather (Telegram and Telegram Trigger nodes).',
  icon: 'send',
  docsAnchor: '#telegram',
  properties: [
    {
      name: 'accessToken',
      displayName: 'Bot Token',
      type: 'string',
      password: true,
      required: true,
      env: 'TELEGRAM_BOT_TOKEN',
      placeholder: '123456789:AAH…',
      description: 'From @BotFather → /newbot (or /mybots → API Token).',
    },
    {
      name: 'chatId',
      displayName: 'Default Chat ID',
      type: 'string',
      env: 'TELEGRAM_CHAT_ID',
      placeholder: '123456789',
      description: 'Used when a Telegram node leaves "Chat ID" empty. Your own id: send /start to your bot, then read message.chat.id in the Telegram Trigger.',
    },
    { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://api.telegram.org', env: 'TELEGRAM_API_URL', description: 'Change it only for a self-hosted Bot API server.' },
  ],
  envRequired: ['TELEGRAM_BOT_TOKEN'],
  async test(data, { signal }) {
    const auth = telegramAuthFrom(data);
    if (!auth.token) return { ok: false, message: 'The bot token is empty', hint: 'Paste the token from @BotFather (/mybots → your bot → API Token).' };
    try {
      const me = await getMe(auth, { signal, timeoutMs: 15_000 });
      return { ok: true, message: `Connected as @${me.username ?? me.first_name} (${me.first_name}).` };
    } catch (err) {
      if (err instanceof IntegrationError) return { ok: false, message: err.message, hint: err.hint };
      const e = err as Error & { hint?: string };
      return { ok: false, message: e.message ?? String(err), hint: e.hint };
    }
  },
});
