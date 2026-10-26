import { getWebhook, parseWebhookUrl } from '../integrations/discord.js';
import { IntegrationError } from '../integrations/errors.js';
import { defineCredential } from './types.js';

export default defineCredential({
  name: 'discordWebhookApi',
  displayName: 'Discord Webhook',
  description: 'The webhook URL of a Discord channel (Discord node).',
  icon: 'message-circle-more',
  docsAnchor: '#discord',
  properties: [
    {
      name: 'webhookUri',
      displayName: 'Webhook URL',
      type: 'string',
      password: true,
      required: true,
      env: 'DISCORD_WEBHOOK_URL',
      placeholder: 'https://discord.com/api/webhooks/…/…',
      description: 'Discord → channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.',
    },
  ],
  envRequired: ['DISCORD_WEBHOOK_URL'],
  /** GET only: nothing is posted to the channel. */
  async test(data, options) {
    try {
      const target = parseWebhookUrl(data.webhookUri);
      const webhook = await getWebhook(target, { signal: options.signal, timeoutMs: 15_000 });
      const name = typeof webhook.name === 'string' && webhook.name ? `"${webhook.name}" ` : '';
      return { ok: true, message: `Webhook ${name}is reachable.` };
    } catch (err) {
      if (err instanceof IntegrationError) return { ok: false, message: err.message, hint: err.hint };
      if (options.signal?.aborted) return { ok: false, message: 'The test was canceled.' };
      return { ok: false, message: (err as Error).message, hint: (err as { hint?: string }).hint };
    }
  },
});
