import type { Attachment, SendMailOptions } from 'nodemailer';
import type { JsonObject } from '@flowforge/shared';
import { CredentialError, NodeOperationError } from '../../engine/errors.js';
import { defineNode, type ExecuteContext } from '../../engine/types.js';
import { renderEmailHtml, renderEmailText } from '../_shared/email-template.js';
import { createSmtpTransport, describeSmtpError, smtpSettings } from '../_shared/smtp.js';

const template = (show: string[] = ['template']) => ({ show: { emailFormat: show } });

/** "a@x.com, b@y.com" / ["a@x.com"] → "a@x.com, b@y.com" (undefined when empty). */
function addressList(value: unknown): string | undefined {
  const list = (Array.isArray(value) ? value : String(value ?? '').split(/[,;\n]/)).map((v) => String(v).trim()).filter(Boolean);
  return list.length ? list.join(', ') : undefined;
}

async function attachmentsFor(ctx: ExecuteContext, itemIndex: number, names: unknown): Promise<Attachment[]> {
  const properties = String(names ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const item = ctx.getInputData()[itemIndex];
  const out: Attachment[] = [];
  for (const property of properties) {
    const ref = item?.binary?.[property];
    if (!ref) {
      throw new NodeOperationError(`Item ${itemIndex} has no binary property "${property}" to attach`, {
        itemIndex,
        hint: `Binary properties of this item: ${Object.keys(item?.binary ?? {}).join(', ') || 'none'}. Use their names, separated by commas.`,
      });
    }
    out.push({ filename: ref.fileName ?? property, content: await ctx.helpers.getBinaryDataBuffer(itemIndex, property), contentType: ref.mimeType });
  }
  return out;
}

export default defineNode({
  description: {
    type: 'flowforge.sendEmail',
    displayName: 'Send Email',
    description: 'Sends an email through SMTP (Gmail, Brevo…): text, HTML or a designed template, with attachments.',
    icon: 'lucide:mail',
    group: 'integration',
    version: 1,
    defaults: { name: 'Send Email', color: '#4ea8ff' },
    subtitle: '{{subject}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ type: 'smtp', required: true }],
    keywords: ['email', 'mail', 'smtp', 'gmail', 'brevo', 'notification', 'send'],
  },
  properties: [
    {
      name: 'fromEmail',
      displayName: 'From Email',
      type: 'string',
      default: '',
      placeholder: 'Shop <you@gmail.com>',
      description: 'Empty: the default sender of the SMTP credential (or SMTP_FROM), else its user. Gmail only sends from your own address.',
    },
    { name: 'toEmail', displayName: 'To Email', type: 'string', default: '', required: true, placeholder: 'info@example.com', description: 'Several recipients: separate them with commas.' },
    { name: 'subject', displayName: 'Subject', type: 'string', default: '', placeholder: 'e.g. Thanks for your message' },
    {
      name: 'emailFormat',
      displayName: 'Email Format',
      type: 'options',
      default: 'html',
      options: [
        { name: 'Designed Template', value: 'template', description: 'Title, message, button and footer in a responsive design' },
        { name: 'HTML', value: 'html', description: 'Your own HTML' },
        { name: 'Text', value: 'text', description: 'Plain text only' },
        { name: 'Both', value: 'both', description: 'HTML with a plain-text alternative' },
      ],
    },
    { name: 'text', displayName: 'Text', type: 'string', default: '', typeOptions: { rows: 5 }, displayOptions: template(['text', 'both']) },
    { name: 'html', displayName: 'HTML', type: 'string', default: '', typeOptions: { rows: 6 }, placeholder: '<h1>Hello</h1>', displayOptions: template(['html', 'both']) },
    { name: 'templateTitle', displayName: 'Title', type: 'string', default: 'Hello!', displayOptions: template() },
    {
      name: 'templateMessage',
      displayName: 'Message',
      type: 'string',
      default: '',
      typeOptions: { rows: 5 },
      description: 'Blank line = new paragraph. Links become clickable, **text** is bold.',
      displayOptions: template(),
    },
    { name: 'templateButtonText', displayName: 'Button Text', type: 'string', default: '', placeholder: 'e.g. Open my order', description: 'Optional. Shown only with a button URL.', displayOptions: template() },
    { name: 'templateButtonUrl', displayName: 'Button URL', type: 'string', default: '', placeholder: 'https://…', displayOptions: template() },
    { name: 'templateFooter', displayName: 'Footer', type: 'string', default: '', typeOptions: { rows: 2 }, placeholder: 'e.g. You receive this email because…', displayOptions: template() },
    { name: 'templateColor', displayName: 'Accent Color', type: 'color', default: '#f0592a', displayOptions: template() },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'ccEmail', displayName: 'CC Email', type: 'string', default: '' },
        { name: 'bccEmail', displayName: 'BCC Email', type: 'string', default: '' },
        { name: 'replyTo', displayName: 'Reply To', type: 'string', default: '' },
        {
          name: 'attachments',
          displayName: 'Attachments',
          type: 'string',
          default: '',
          placeholder: 'data, invoice',
          description: 'Names of the binary properties to attach, separated by commas.',
        },
        { name: 'timeout', displayName: 'Timeout (Seconds)', type: 'number', default: 20, typeOptions: { minValue: 1, maxValue: 120 } },
        { name: 'allowUnauthorizedCerts', displayName: 'Ignore SSL Issues', type: 'boolean', default: false },
      ],
    },
  ],
  /** Demo Mode: what a sent email would look like (no credential, nothing is sent). */
  simulate(ctx, _item, i) {
    const to = String(ctx.getNodeParameter('toEmail', i, '') ?? '');
    return { accepted: to ? [to] : [], rejected: [], messageId: 'simulated' };
  },

  async execute(ctx) {
    const credential = await ctx.getCredentials('smtp');
    const settings = smtpSettings(credential.data);
    if (!settings.host) {
      throw new CredentialError('The SMTP host is empty', { credentialType: 'smtp', credentialId: credential.id, hint: 'Edit the SMTP credential: smtp.gmail.com for Gmail.' });
    }
    const options = ctx.getNodeParameter<JsonObject>('options', 0, {});
    const timeoutMs = Math.min(Math.max(Number(options.timeout ?? 20) || 20, 1), 120) * 1000;
    const transport = createSmtpTransport(settings, { timeoutMs, allowUnauthorizedCerts: options.allowUnauthorizedCerts === true });
    const abort = () => transport.close();
    ctx.signal.addEventListener('abort', abort, { once: true });
    try {
      const sent = await ctx.forEachItem(async (_item, i) => {
        const to = addressList(ctx.getNodeParameter('toEmail', i, ''));
        if (!to) throw new NodeOperationError('No recipient: "To Email" is empty', { itemIndex: i, hint: 'Enter an address, or an expression such as {{ $json.Email }}.' });
        const from = String(ctx.getNodeParameter('fromEmail', i, '') || credential.data.from || settings.user).trim();
        if (!from) throw new NodeOperationError('No sender: "From Email" is empty', { itemIndex: i, hint: 'Enter a From address (or a user in the SMTP credential).' });
        const itemOptions = ctx.getNodeParameter<JsonObject>('options', i, {});
        const format = String(ctx.getNodeParameter('emailFormat', i, 'html'));
        const message: SendMailOptions = {
          from,
          to,
          subject: String(ctx.getNodeParameter('subject', i, '')),
          cc: addressList(itemOptions.ccEmail),
          bcc: addressList(itemOptions.bccEmail),
          replyTo: addressList(itemOptions.replyTo),
          attachments: await attachmentsFor(ctx, i, itemOptions.attachments),
        };
        if (format === 'template') {
          const content = {
            title: String(ctx.getNodeParameter('templateTitle', i, '')),
            message: String(ctx.getNodeParameter('templateMessage', i, '')),
            buttonText: String(ctx.getNodeParameter('templateButtonText', i, '')),
            buttonUrl: String(ctx.getNodeParameter('templateButtonUrl', i, '')),
            footer: String(ctx.getNodeParameter('templateFooter', i, '')),
            color: String(ctx.getNodeParameter('templateColor', i, '')),
          };
          message.html = renderEmailHtml(content);
          message.text = renderEmailText(content);
        } else {
          if (format === 'text' || format === 'both') message.text = String(ctx.getNodeParameter('text', i, ''));
          if (format === 'html' || format === 'both') message.html = String(ctx.getNodeParameter('html', i, ''));
        }

        let info;
        try {
          info = await transport.sendMail(message);
        } catch (err) {
          if (ctx.signal.aborted) throw ctx.signal.reason;
          const problem = describeSmtpError(err, settings);
          if (problem.auth) {
            const fromEnv = credential.source === 'env' ? ' The values come from .env (SMTP_USER / SMTP_PASS).' : '';
            throw new CredentialError(problem.message, { credentialType: 'smtp', credentialId: credential.id, hint: `${problem.hint ?? ''}${fromEnv}`.trim(), itemIndex: i });
          }
          throw new NodeOperationError(problem.message, { hint: problem.hint, itemIndex: i });
        }
        return {
          json: {
            messageId: info.messageId,
            accepted: (info.accepted ?? []).map(String),
            rejected: (info.rejected ?? []).map(String),
            response: String(info.response ?? ''),
            envelope: { from: String(info.envelope?.from ?? ''), to: (info.envelope?.to ?? []).map(String) },
          },
        };
      });
      return [sent];
    } finally {
      ctx.signal.removeEventListener('abort', abort);
      transport.close();
    }
  },
});
