// The checks behind `npm run check`: one real call per integration, with the same clients and the same
// credential test() functions as the nodes and the Test button of the Credentials page.
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowNode } from '@flowforge/shared';
import { createApp, type FlowForgeApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createContext } from '../context.js';
import type { CredentialTypeRegistry } from '../credentials/registry.js';
import { openDatabase } from '../db/index.js';
import { FlowError, MissingCredentialError } from '../engine/errors.js';
import type { ResolvedCredential } from '../engine/types.js';
import { executeWebhook, parseWebhookUrl } from '../integrations/discord.js';
import { IntegrationError } from '../integrations/errors.js';
import { describeWeatherCode, forecast, geocode } from '../integrations/open-meteo.js';
import { telegramAuthFrom, telegramCall } from '../integrations/telegram.js';
import { silentLogger } from '../logger.js';
import { renderEmailHtml, renderEmailText } from '../nodes/_shared/email-template.js';
import { redact } from '../nodes/_shared/http-client.js';
import { createSmtpTransport, describeSmtpError, smtpSettings } from '../nodes/_shared/smtp.js';
import { loadNodeRegistry } from '../nodes/registry.js';

export type CheckStatus = 'OK' | 'FAIL' | 'SKIP';

export interface CheckRow {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What to do (FAIL) or what to set where (SKIP). */
  hint?: string;
}

export interface CheckDeps {
  /** Same lookup as the nodes without a selected credential: default credential of the type → `.env`. Throws MissingCredentialError. */
  resolve(type: string): ResolvedCredential;
  types: CredentialTypeRegistry;
  env: NodeJS.ProcessEnv;
  /** `--send`: also post a test message to the Discord channel. */
  send: boolean;
  /** Open-Meteo servers (the tests use a local mock). */
  weather?: { forecastUrl?: string; geocodingUrl?: string };
  /** Replaces the local form self-test (tests). */
  forms?(): Promise<CheckRow>;
}

const SETUP: Record<string, { name: string; skip: string }> = {
  smtp: { name: 'Email (SMTP)', skip: 'Add an "SMTP" credential on the Credentials page, or set SMTP_HOST, SMTP_USER and SMTP_PASS in .env (API_SETUP.md#email-smtp).' },
  telegramApi: { name: 'Telegram', skip: 'Add a "Telegram Bot" credential on the Credentials page, or set TELEGRAM_BOT_TOKEN in .env (API_SETUP.md#telegram).' },
  discordWebhookApi: { name: 'Discord', skip: 'Add a "Discord Webhook" credential on the Credentials page, or set DISCORD_WEBHOOK_URL in .env (API_SETUP.md#discord).' },
  googlePalmApi: { name: 'Google Gemini', skip: 'Add a "Google Gemini API" credential on the Credentials page, or set GEMINI_API_KEY in .env (API_SETUP.md#google-gemini).' },
};

const sourceOf = (c: ResolvedCredential) => (c.source === 'env' ? '.env' : `credential "${c.name}"`);

function problem(err: unknown): { detail: string; hint?: string } {
  if (err instanceof IntegrationError || err instanceof FlowError) return { detail: err.message, hint: err.hint };
  return { detail: err instanceof Error ? err.message : String(err) };
}

/**
 * Runs every check and returns the rows in display order. Never throws; a secret of a credential can never
 * show up in a row (every text is redacted with the secret values of the credentials that were used).
 */
export async function runChecks(deps: CheckDeps): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  const secrets: string[] = [];
  const add = (name: string, status: CheckStatus, detail: string, hint?: string) =>
    rows.push({ name, status, detail: redact(detail, secrets), ...(hint ? { hint: redact(hint, secrets) } : {}) });

  /** Resolves the credential and runs its test(): the very function behind the Test button. */
  const connect = async (typeName: string): Promise<ResolvedCredential | undefined> => {
    const { name, skip } = SETUP[typeName]!;
    const type = deps.types.get(typeName)!;
    let credential: ResolvedCredential;
    try {
      credential = deps.resolve(typeName);
    } catch (err) {
      if (err instanceof MissingCredentialError) add(name, 'SKIP', 'Not configured', skip);
      else add(name, 'FAIL', problem(err).detail, problem(err).hint);
      return undefined;
    }
    for (const p of type.properties) {
      const value = credential.data[p.name];
      if (p.password && typeof value === 'string' && value) secrets.push(value);
    }
    try {
      const outcome = await type.test!(credential.data, {});
      if (!outcome.ok) {
        add(name, 'FAIL', `${outcome.message} (${sourceOf(credential)})`, outcome.hint);
        return undefined;
      }
      add(name, 'OK', `${outcome.message} (${sourceOf(credential)})`);
      return credential;
    } catch (err) {
      add(name, 'FAIL', problem(err).detail, problem(err).hint);
      return undefined;
    }
  };
  /** Follow-up rows are skipped (not failed twice) when the connection row did not pass. */
  const notReached = (name: string, of: string) => {
    if (rows.some((r) => r.name === of && r.status === 'FAIL')) add(name, 'SKIP', `Skipped: ${of} failed`);
  };

  // ── Email ──────────────────────────────────────────────────────────────────
  const smtp = await connect('smtp');
  const emailRow = 'Email: test message';
  if (smtp) {
    const to = deps.env.CHECK_EMAIL_TO?.trim();
    if (!to) add(emailRow, 'SKIP', 'No recipient', 'Set CHECK_EMAIL_TO=you@example.com in .env to also send a real email (or run npm run check:email).');
    else {
      const settings = smtpSettings(smtp.data);
      const transport = createSmtpTransport(settings);
      const content = { title: 'FlowForge check ✅', message: `FlowForge can send emails through ${settings.host}.\n\nSent at ${new Date().toLocaleString()}.`, footer: 'Sent by npm run check' };
      try {
        await transport.sendMail({ from: String(smtp.data.from || settings.user), to, subject: 'FlowForge check', html: renderEmailHtml(content), text: renderEmailText(content) });
        add(emailRow, 'OK', `Email sent to ${to}`);
      } catch (err) {
        const p = describeSmtpError(err, settings);
        add(emailRow, 'FAIL', p.message, p.hint);
      } finally {
        transport.close();
      }
    }
  } else notReached(emailRow, SETUP.smtp!.name);

  // ── Forms (no key: a private copy of the server on a free port) ─────────────
  rows.push(await (deps.forms ?? checkForms)().catch((err: unknown) => ({ name: 'Forms', status: 'FAIL' as const, ...problem(err) })));

  // ── Telegram ───────────────────────────────────────────────────────────────
  const telegram = await connect('telegramApi');
  const telegramRow = 'Telegram: test message';
  if (telegram) {
    const auth = telegramAuthFrom(telegram.data);
    if (!auth.chatId) add(telegramRow, 'SKIP', 'No chat id', 'Set TELEGRAM_CHAT_ID in .env, or "Default Chat ID" in the Telegram Bot credential (API_SETUP.md#telegram shows how to find it).');
    else {
      try {
        await telegramCall(auth, 'sendMessage', { chat_id: auth.chatId, text: `✅ FlowForge check: your bot can send messages (${new Date().toLocaleTimeString()}).` }, { timeoutMs: 20_000 });
        add(telegramRow, 'OK', `Message sent to chat ${auth.chatId}`);
      } catch (err) {
        add(telegramRow, 'FAIL', problem(err).detail, problem(err).hint);
      }
    }
  } else notReached(telegramRow, SETUP.telegramApi!.name);

  // ── Discord ────────────────────────────────────────────────────────────────
  const discord = await connect('discordWebhookApi');
  const discordRow = 'Discord: test message';
  if (discord) {
    if (!deps.send) add(discordRow, 'SKIP', 'Nothing was posted', 'Run "npm run check -- --send" to post a test message in the channel.');
    else {
      try {
        const message = await executeWebhook(
          parseWebhookUrl(discord.data.webhookUri),
          { content: '', embeds: [{ title: '✅ FlowForge check', description: 'This webhook works: FlowForge can post here.', color: 0x57f287, timestamp: new Date().toISOString() }], wait: true },
          { timeoutMs: 20_000 },
        );
        add(discordRow, 'OK', `Message posted (id ${String(message.id ?? '?')})`);
      } catch (err) {
        add(discordRow, 'FAIL', problem(err).detail, problem(err).hint);
      }
    }
  } else notReached(discordRow, SETUP.discordWebhookApi!.name);

  // ── Open-Meteo (no key) ────────────────────────────────────────────────────
  try {
    const [place] = await geocode('Paris', { count: 1, baseUrl: deps.weather?.geocodingUrl }, { timeoutMs: 15_000 });
    if (!place) throw new IntegrationError('Open-Meteo', 'The place search did not find Paris', { hint: 'Open-Meteo may have a problem: try again later.' });
    const weather = await forecast({ latitude: place.latitude, longitude: place.longitude, current: true, baseUrl: deps.weather?.forecastUrl }, { timeoutMs: 15_000 });
    const current = (weather.current ?? {}) as Record<string, unknown>;
    const { description, emoji } = describeWeatherCode(current.weather_code, current.is_day !== 0);
    const unit = String((weather.current_units as Record<string, unknown> | undefined)?.temperature_2m ?? '°C');
    add('Weather (Open-Meteo)', 'OK', `${place.name}: ${emoji} ${description}, ${String(current.temperature_2m)} ${unit} (no key needed)`);
  } catch (err) {
    add('Weather (Open-Meteo)', 'FAIL', problem(err).detail, problem(err).hint ?? 'Check the internet connection of this computer.');
  }

  // ── Gemini ─────────────────────────────────────────────────────────────────
  await connect('googlePalmApi');

  return rows;
}

const FORM_NODE = {
  id: 'form',
  name: 'Form',
  type: 'flowforge.formTrigger',
  typeVersion: 1,
  position: [0, 0],
  parameters: {
    formTitle: 'Check',
    formFields: [
      { id: 'name', fieldLabel: 'Name', fieldType: 'text', requiredField: true },
      { id: 'email', fieldLabel: 'Email', fieldType: 'email', requiredField: true },
    ],
    options: { path: 'check' },
  },
} as unknown as WorkflowNode;

/**
 * Forms need no key, so the check is a self-test: a private FlowForge (in-memory database, free port) publishes a
 * form, the page is fetched, a bad and a good answer are submitted over HTTP and the started execution is read back.
 */
export async function checkForms(): Promise<CheckRow> {
  const name = 'Forms';
  const dataDir = mkdtempSync(join(tmpdir(), 'ff-check-'));
  let app: FlowForgeApp | undefined;
  try {
    const config = { ...loadConfig({ HOST: '127.0.0.1' }), dataDir, filesRoot: join(dataDir, 'files'), publicUrl: 'http://127.0.0.1' };
    const ctx = createContext(config, openDatabase(':memory:'), silentLogger, await loadNodeRegistry(), { env: {} });
    app = createApp(ctx);
    await new Promise<void>((resolve) => app!.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/form/check`;
    const workflow = ctx.workflowsRepo.create({ name: 'Form check', nodes: [FORM_NODE], connections: {} });
    await app.activeWorkflows.activate(workflow.id);

    const page = await fetch(url);
    const html = await page.text();
    if (page.status !== 200 || !html.includes('Email')) return { name, status: 'FAIL', detail: `The form page answered ${page.status}` };

    const post = (body: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
    const invalid = await post('field-0=&field-1=not-an-email');
    if (invalid.status !== 400) return { name, status: 'FAIL', detail: `An invalid answer was not refused (status ${invalid.status})` };
    const valid = await post('field-0=Ada&field-1=ada%40example.com');
    if (valid.status !== 200) return { name, status: 'FAIL', detail: `A valid answer was refused (status ${valid.status})` };

    for (let i = 0; i < 100; i++) {
      const [execution] = ctx.executionsRepo.list({ workflowId: workflow.id });
      if (execution && !['queued', 'running'].includes(execution.status)) {
        const answer = ctx.executionsRepo.get(execution.id)?.runData.Form?.[0]?.data.main[0]?.[0]?.json;
        if (execution.status !== 'success' || answer?.Name !== 'Ada') return { name, status: 'FAIL', detail: `The submission started an execution that ended as "${execution.status}"` };
        return { name, status: 'OK', detail: 'Page served, bad answer refused, good answer started a workflow (local self-test, no key needed)' };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return { name, status: 'FAIL', detail: 'The submission did not start an execution within 5 s' };
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Plain-text table for the terminal (colors optional). */
export function formatRows(rows: CheckRow[], color = true): string {
  const paint: Record<CheckStatus, string> = { OK: '32', FAIL: '31', SKIP: '33' };
  const width = Math.max(...rows.map((r) => r.name.length), 'Integration'.length);
  const lines = [`  ${'Integration'.padEnd(width)}  Result  Details`, `  ${'─'.repeat(width)}  ──────  ${'─'.repeat(40)}`];
  for (const row of rows) {
    const status = row.status.padEnd(6);
    lines.push(`  ${row.name.padEnd(width)}  ${color ? `\x1b[${paint[row.status]}m${status}\x1b[0m` : status}  ${row.detail}`);
    if (row.hint) lines.push(`  ${' '.repeat(width)}          → ${row.hint}`);
  }
  const count = (s: CheckStatus) => rows.filter((r) => r.status === s).length;
  lines.push('', `  ${count('OK')} OK, ${count('FAIL')} failed, ${count('SKIP')} skipped`);
  return lines.join('\n');
}
