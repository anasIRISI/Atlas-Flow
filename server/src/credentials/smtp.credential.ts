import { smtpSettings, verifySmtp } from '../nodes/_shared/smtp.js';
import { defineCredential } from './types.js';

export default defineCredential({
  name: 'smtp',
  displayName: 'SMTP',
  description: 'Send emails with Gmail (App Password), Brevo or any SMTP server.',
  icon: 'mail',
  docsAnchor: '#email-smtp',
  properties: [
    { name: 'host', displayName: 'Host', type: 'string', required: true, placeholder: 'smtp.gmail.com', env: 'SMTP_HOST' },
    { name: 'port', displayName: 'Port', type: 'number', default: 465, required: true, env: 'SMTP_PORT', description: '465 with SSL/TLS on, or 587 with SSL/TLS off (STARTTLS).' },
    { name: 'secure', displayName: 'SSL/TLS', type: 'boolean', default: true, env: 'SMTP_SECURE', description: 'On for port 465. Off for port 587 (the connection is upgraded with STARTTLS).' },
    { name: 'user', displayName: 'User', type: 'string', placeholder: 'you@gmail.com', env: 'SMTP_USER' },
    {
      name: 'password',
      displayName: 'Password',
      type: 'string',
      password: true,
      env: 'SMTP_PASS',
      description: 'Gmail: a 16-letter App Password, not your normal password. Brevo: your SMTP key.',
    },
    {
      name: 'from',
      displayName: 'Default Sender (From)',
      type: 'string',
      placeholder: 'FlowForge <you@gmail.com>',
      env: 'SMTP_FROM',
      description: 'Used when the Send Email node leaves "From" empty. Default: the user above.',
    },
  ],
  presets: [
    {
      id: 'gmail',
      name: 'Gmail',
      description: 'smtp.gmail.com:465 · user = your Gmail address · password = App Password (myaccount.google.com/apppasswords)',
      values: { host: 'smtp.gmail.com', port: 465, secure: true },
    },
    {
      id: 'brevo',
      name: 'Brevo',
      description: 'smtp-relay.brevo.com:587 · user = SMTP login · password = SMTP key (app.brevo.com → SMTP & API)',
      values: { host: 'smtp-relay.brevo.com', port: 587, secure: false },
    },
  ],
  envRequired: ['SMTP_HOST'],
  normalize(data) {
    const out = { ...data };
    if (out.port === undefined || out.port === '') out.port = out.secure === false ? 587 : 465;
    if (out.secure === undefined || out.secure === '') out.secure = Number(out.port) === 465;
    return out;
  },
  async test(data) {
    const s = smtpSettings(data);
    const result = await verifySmtp(s);
    if (result.ok) {
      return { ok: true, message: `Connected to ${s.host}:${s.port}${s.user ? ` and signed in as ${s.user}` : ''}.` };
    }
    return { ok: false, message: result.error.message, hint: result.error.hint };
  },
});
