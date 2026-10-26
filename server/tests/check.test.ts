import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkForms, formatRows, runChecks, type CheckDeps, type CheckRow } from '../src/cli/checks.js';
import { completeData, CredentialTypeRegistry, fromEnv } from '../src/credentials/registry.js';
import { MissingCredentialError } from '../src/engine/errors.js';
import { startDiscordMock, WEBHOOK_TOKEN, type DiscordMock } from './discord-mock.js';
import { answer, apiError, startGeminiMock, type GeminiMock } from './gemini-mock.js';
import { startOpenMeteoMock, type OpenMeteoMock } from './open-meteo-mock.js';
import { startFakeSmtp, type FakeSmtp } from './smtp-helpers.js';
import { startTelegramMock, TG_TOKEN, type TelegramMock } from './telegram-mock.js';

const LOGIN = { user: 'sender@flowforge.test', pass: 'app-password-123' };
const GEMINI_KEY = 'AIzaSy-check-key-0123456789';

let smtp: FakeSmtp;
let telegram: TelegramMock;
let discord: DiscordMock;
let gemini: GeminiMock;
let meteo: OpenMeteoMock;

beforeEach(async () => {
  [smtp, telegram, discord, gemini, meteo] = await Promise.all([startFakeSmtp(LOGIN), startTelegramMock(), startDiscordMock(), startGeminiMock(), startOpenMeteoMock()]);
});
afterEach(async () => {
  await Promise.all([smtp.close(), telegram.close(), discord.close(), gemini.close(), meteo.close()]);
});

const formsOk = async (): Promise<CheckRow> => ({ name: 'Forms', status: 'OK', detail: 'stub' });

/** Like the CLI when no database exists: credentials come from the given `.env` values only. */
function deps(env: NodeJS.ProcessEnv, extra: Partial<CheckDeps> = {}): CheckDeps {
  const types = new CredentialTypeRegistry();
  return {
    types,
    env,
    send: false,
    forms: formsOk,
    weather: { forecastUrl: meteo.forecastUrl, geocodingUrl: meteo.geocodingUrl },
    resolve: (name) => {
      const type = types.get(name)!;
      const data = fromEnv(type, env);
      if (!data) throw new MissingCredentialError(name, type.displayName, type.envRequired?.[0], type.docsAnchor);
      return { data: completeData(type, data), source: 'env', name: '.env' };
    },
    ...extra,
  };
}

const fullEnv = (): NodeJS.ProcessEnv => ({
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String(smtp.port),
  SMTP_SECURE: 'false',
  SMTP_USER: LOGIN.user,
  SMTP_PASS: LOGIN.pass,
  CHECK_EMAIL_TO: 'me@example.com',
  TELEGRAM_BOT_TOKEN: TG_TOKEN,
  TELEGRAM_CHAT_ID: '4242',
  TELEGRAM_API_URL: telegram.url,
  DISCORD_WEBHOOK_URL: discord.url,
  GEMINI_API_KEY: GEMINI_KEY,
  GEMINI_API_URL: gemini.url,
});

const byName = (rows: CheckRow[]) => Object.fromEntries(rows.map((r) => [r.name, r]));

describe('npm run check', () => {
  it('reports OK for every configured integration and really calls each of them', async () => {
    gemini.enqueue(answer('OK'));
    const rows = await runChecks(deps(fullEnv()));
    const r = byName(rows);
    expect(rows.map((x) => x.name)).toEqual(['Email (SMTP)', 'Email: test message', 'Forms', 'Telegram', 'Telegram: test message', 'Discord', 'Discord: test message', 'Weather (Open-Meteo)', 'Google Gemini']);
    expect(rows.filter((x) => x.status === 'FAIL')).toEqual([]);

    expect(r['Email (SMTP)']).toMatchObject({ status: 'OK', detail: expect.stringContaining('(.env)') });
    expect(r['Email: test message']).toMatchObject({ status: 'OK', detail: 'Email sent to me@example.com' });
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.envelope.to).toEqual(['me@example.com']);

    expect(r.Telegram!.detail).toMatch(/Connected as @\w+/);
    expect(r['Telegram: test message']).toMatchObject({ status: 'OK', detail: 'Message sent to chat 4242' });
    expect(telegram.calls('sendMessage')[0]!.body).toMatchObject({ chat_id: '4242' });

    // Discord: only a GET unless --send is given.
    expect(r.Discord!.status).toBe('OK');
    expect(r['Discord: test message']).toMatchObject({ status: 'SKIP', hint: expect.stringContaining('npm run check -- --send') });
    expect(discord.requests.map((x) => x.method)).toEqual(['GET']);

    expect(r['Weather (Open-Meteo)']!.detail).toMatch(/^Paris: .+ °C \(no key needed\)$/);
    expect(r['Google Gemini']!.detail).toContain('The key works');
    expect(gemini.calls[0]!.headers['x-goog-api-key']).toBe(GEMINI_KEY);
  });

  it('posts to Discord only with --send', async () => {
    const rows = await runChecks(deps(fullEnv(), { send: true }));
    expect(byName(rows)['Discord: test message']).toMatchObject({ status: 'OK', detail: expect.stringMatching(/^Message posted \(id \d+\)$/) });
    expect(discord.requests.map((x) => x.method)).toEqual(['GET', 'POST']);
  });

  it('skips what is not configured and says exactly what to set where', async () => {
    const rows = await runChecks(deps({}));
    const r = byName(rows);
    expect(rows.filter((x) => x.status === 'FAIL')).toEqual([]);
    expect(r['Email (SMTP)']).toMatchObject({ status: 'SKIP', detail: 'Not configured', hint: expect.stringMatching(/SMTP_HOST, SMTP_USER and SMTP_PASS in \.env.*API_SETUP\.md#email-smtp/) });
    expect(r.Telegram!.hint).toMatch(/"Telegram Bot" credential.*TELEGRAM_BOT_TOKEN in \.env/);
    expect(r.Discord!.hint).toMatch(/"Discord Webhook" credential.*DISCORD_WEBHOOK_URL in \.env/);
    expect(r['Google Gemini']!.hint).toMatch(/"Google Gemini API" credential.*GEMINI_API_KEY in \.env/);
    expect(r['Weather (Open-Meteo)']!.status).toBe('OK');
    // No follow-up rows for integrations that are not configured.
    expect(rows.map((x) => x.name)).toEqual(['Email (SMTP)', 'Forms', 'Telegram', 'Discord', 'Weather (Open-Meteo)', 'Google Gemini']);
    expect(smtp.messages).toHaveLength(0);
    expect(telegram.requests).toHaveLength(0);
  });

  it('asks for the optional recipient and chat id instead of failing', async () => {
    const env = fullEnv();
    delete env.CHECK_EMAIL_TO;
    delete env.TELEGRAM_CHAT_ID;
    const r = byName(await runChecks(deps(env)));
    expect(r['Email: test message']).toMatchObject({ status: 'SKIP', hint: expect.stringContaining('CHECK_EMAIL_TO=you@example.com') });
    expect(r['Telegram: test message']).toMatchObject({ status: 'SKIP', hint: expect.stringContaining('TELEGRAM_CHAT_ID') });
    expect(smtp.messages).toHaveLength(0);
    expect(telegram.calls('sendMessage')).toHaveLength(0);
  });

  it('reports FAIL with the reason for wrong keys, and never prints a secret', async () => {
    const env = { ...fullEnv(), SMTP_PASS: 'wrong-password-999', TELEGRAM_BOT_TOKEN: '999999:WRONG-token-value-abc', DISCORD_WEBHOOK_URL: discord.url.replace(WEBHOOK_TOKEN, 'wrong-token-zzz999') };
    gemini.enqueue(apiError(400, 'API key not valid. Please pass a valid API key.', [{ reason: 'API_KEY_INVALID' }], 'INVALID_ARGUMENT'));
    meteo.override.geocoding = { status: 500, body: 'oops' };
    const rows = await runChecks(deps(env));
    const r = byName(rows);
    expect(r['Email (SMTP)']).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/authentication failed/i) });
    expect(r['Email: test message']).toMatchObject({ status: 'SKIP', detail: 'Skipped: Email (SMTP) failed' });
    expect(r.Telegram!.status).toBe('FAIL');
    expect(r['Telegram: test message']!.status).toBe('SKIP');
    expect(r.Discord).toMatchObject({ status: 'FAIL', hint: expect.stringContaining('webhook') });
    expect(r['Weather (Open-Meteo)']!.status).toBe('FAIL');
    expect(r['Google Gemini']).toMatchObject({ status: 'FAIL', detail: expect.stringContaining('The Gemini API key is not valid') });

    const printed = `${JSON.stringify(rows)}\n${formatRows(rows, false)}`;
    for (const secret of ['wrong-password-999', 'WRONG-token-value-abc', 'wrong-token-zzz999', GEMINI_KEY, LOGIN.pass, TG_TOKEN]) expect(printed).not.toContain(secret);
    expect(smtp.messages).toHaveLength(0);
    expect(telegram.calls('sendMessage')).toHaveLength(0);
    expect(discord.requests.every((x) => x.method === 'GET')).toBe(true);
  });

  it('prints an aligned table with hints and a summary line', () => {
    const text = formatRows(
      [
        { name: 'Telegram', status: 'OK', detail: 'Connected as @bot (.env)' },
        { name: 'Discord', status: 'SKIP', detail: 'Not configured', hint: 'Set DISCORD_WEBHOOK_URL in .env' },
        { name: 'Google Gemini', status: 'FAIL', detail: 'The Gemini API key is not valid' },
      ],
      false,
    );
    expect(text).toContain('  Telegram       OK      Connected as @bot (.env)');
    expect(text).toContain('  Discord        SKIP    Not configured');
    expect(text).toContain('→ Set DISCORD_WEBHOOK_URL in .env');
    expect(text).toContain('  Google Gemini  FAIL    The Gemini API key is not valid');
    expect(text).toContain('1 OK, 1 failed, 1 skipped');
    expect(text).not.toContain('\x1b[');
    expect(formatRows([{ name: 'X', status: 'OK', detail: 'd' }], true)).toContain('\x1b[32mOK');
  });

  it('self-tests the forms on a private server (page, validation, submission, execution)', async () => {
    const row = await checkForms();
    expect(row).toMatchObject({ name: 'Forms', status: 'OK' });
    expect(row.detail).toContain('good answer started a workflow');
  });
});
