import nodemailer from 'nodemailer';
import type { CredentialData } from '../../credentials/types.js';

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}

export interface SmtpErrorInfo {
  message: string;
  hint?: string;
  /** The server refused the user/password: the credential must be fixed. */
  auth: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function smtpSettings(data: CredentialData): SmtpSettings {
  const port = Number(data.port) || 587;
  return {
    host: String(data.host ?? '').trim(),
    port,
    secure: data.secure === true || data.secure === 'true',
    user: String(data.user ?? '').trim(),
    // Gmail shows App Passwords as "abcd efgh ijkl mnop": the spaces are not part of it.
    password: String(data.password ?? '').replace(/\s+/g, ''),
  };
}

/** SMTP transport with timeouts; never reads local files or URLs given in a message. */
export function createSmtpTransport(s: SmtpSettings, options: { timeoutMs?: number; allowUnauthorizedCerts?: boolean } = {}) {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    ...(s.user ? { auth: { user: s.user, pass: s.password } } : {}),
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: Math.max(timeout, 30_000),
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: options.allowUnauthorizedCerts ? { rejectUnauthorized: false } : undefined,
  });
}

/** Turns nodemailer errors into a short message and an actionable hint. */
export function describeSmtpError(err: unknown, s: SmtpSettings): SmtpErrorInfo {
  const e = (err ?? {}) as { code?: string; responseCode?: number; message?: string; response?: string };
  const where = `${s.host}:${s.port}`;
  const server = (e.response ?? e.message ?? '').toString().slice(0, 300);
  const gmail = /gmail|googlemail/i.test(s.host);
  if (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534) {
    return {
      auth: true,
      message: `SMTP authentication failed for "${s.user || '(no user)'}" on ${s.host}`,
      hint: gmail
        ? 'Gmail needs an App Password (16 letters), not your normal password: https://myaccount.google.com/apppasswords (2-Step Verification must be on).'
        : `Check the user and password of the SMTP credential. Server said: ${server}`,
    };
  }
  if (e.code === 'ENOAUTH') {
    return { auth: true, message: `The SMTP server ${s.host} requires a login`, hint: 'Fill in the user and password of the SMTP credential.' };
  }
  if (e.code === 'ETIMEDOUT' || /timeout/i.test(e.message ?? '')) {
    return {
      auth: false,
      message: `Timed out while talking to the SMTP server ${where}`,
      hint: `Check host and port. Port 465 needs "SSL/TLS" on, port 587 needs it off. A school or company network may block outgoing SMTP: try another network.`,
    };
  }
  if (e.code === 'EDNS' || /ENOTFOUND|EAI_AGAIN/.test(e.message ?? '')) {
    return { auth: false, message: `SMTP server "${s.host}" not found`, hint: 'Check the host name (e.g. smtp.gmail.com) and your internet connection.' };
  }
  if (/ECONNREFUSED/.test(e.message ?? '')) {
    return { auth: false, message: `Connection refused by ${where}`, hint: 'Check the port: 465 (SSL/TLS) or 587 (STARTTLS) for most providers.' };
  }
  if (e.code === 'ETLS' || /wrong version number|SSL routines|certificate/i.test(e.message ?? '')) {
    return {
      auth: false,
      message: `TLS problem with ${where}: ${e.message ?? 'handshake failed'}`,
      hint: s.port === 587 && s.secure ? 'Port 587 uses STARTTLS: turn "SSL/TLS" off.' : s.port === 465 && !s.secure ? 'Port 465 needs "SSL/TLS" on.' : 'Check the port and the SSL/TLS switch.',
    };
  }
  if (e.code === 'EENVELOPE') {
    return { auth: false, message: `The server rejected the sender or a recipient: ${server}`, hint: 'Check the From and To addresses.' };
  }
  if (e.code === 'ECONNECTION' || e.code === 'ESOCKET') {
    return { auth: false, message: `Connection to ${where} failed: ${e.message ?? 'socket error'}`, hint: 'Check host, port and the SSL/TLS switch.' };
  }
  return { auth: false, message: `Sending failed: ${server || 'unknown SMTP error'}` };
}

/** Checks host, port, TLS and login (the credential "Test" button). */
export async function verifySmtp(s: SmtpSettings, timeoutMs = 15_000): Promise<{ ok: true } | { ok: false; error: SmtpErrorInfo }> {
  if (!s.host) return { ok: false, error: { auth: false, message: 'The SMTP host is empty', hint: 'For Gmail use smtp.gmail.com, for Brevo smtp-relay.brevo.com.' } };
  const transport = createSmtpTransport(s, { timeoutMs });
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeSmtpError(err, s) };
  } finally {
    transport.close();
  }
}
