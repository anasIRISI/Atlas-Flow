import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CredentialSummary, JsonObject } from '@flowforge/shared';
import { describeTelegramError, telegramCall } from '../src/integrations/telegram.js';
import { IntegrationError } from '../src/integrations/errors.js';
import { updateToItem } from '../src/nodes/triggers/telegram-trigger.node.js';
import { closedPort } from './http-mock.js';
import { capturingLogger, makeTestApp, type TestApp } from './helpers.js';
import { startTelegramMock, TG_TOKEN, type TelegramMock } from './telegram-mock.js';
import { chain, node, signedIn, type Agent } from './trigger-helpers.js';

let t: TestApp;
let agent: Agent;
let tg: TelegramMock;
let logger: ReturnType<typeof capturingLogger>;

beforeEach(async () => {
  tg = await startTelegramMock();
  logger = capturingLogger();
});
afterEach(async () => {
  await t?.close();
  await tg.close();
});

async function start(env: NodeJS.ProcessEnv = {}) {
  t = await makeTestApp({}, { env, logger });
  agent = await signedIn(t);
}

async function saveCredential(data: JsonObject = {}, name = 'Test bot') {
  const res = await agent.post('/api/credentials').send({ name, type: 'telegramApi', data: { accessToken: TG_TOKEN, chatId: '555', baseUrl: tg.url, ...data } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as CredentialSummary;
}

interface RunSummary {
  status: string;
  error?: { message: string; hint?: string; credentialType?: string; credentialId?: string; envVar?: string; docsAnchor?: string; node?: string; itemIndex?: number };
  nodes: { node: string; status: string; error?: string }[];
  output: JsonObject[][];
}

/** Manual Trigger → (items) → [extra nodes] → Telegram, run through the dev API. */
async function run(parameters: JsonObject, items: JsonObject[] = [{}], o: { before?: ReturnType<typeof node>[]; settings?: JsonObject } = {}): Promise<RunSummary> {
  const before = o.before ?? [];
  const names = ['Start', 'Items', ...before.map((n) => n.name), 'Telegram'];
  const nodes = [node('Start', 'manualTrigger'), node('Items', 'code', { jsCode: `return ${JSON.stringify(items)}.map((json) => ({ json }));` }), ...before, node('Telegram', 'telegram', parameters, o.settings ?? {})];
  const res = await agent.post('/api/dev/run').send({ name: 'Telegram', nodes, connections: chain(...names) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as RunSummary;
}

describe('Telegram node: operations', () => {
  it('sends a message with all options and returns the Message object', async () => {
    await start();
    await saveCredential();
    const result = await run({
      operation: 'sendMessage',
      chatId: '777',
      text: 'Hello <b>Bob</b>',
      parseMode: 'HTML',
      options: { disableNotification: true, disableLinkPreview: true, protectContent: true, replyToMessageId: '12', messageThreadId: '3' },
    });
    expect(result.status).toBe('success');
    const call = tg.calls('sendMessage')[0]!;
    expect(call.token).toBe(TG_TOKEN);
    expect(call.contentType).toContain('application/json');
    expect(call.body).toEqual({
      chat_id: '777',
      text: 'Hello <b>Bob</b>',
      parse_mode: 'HTML',
      disable_notification: true,
      protect_content: true,
      reply_parameters: { message_id: 12 },
      message_thread_id: 3,
      link_preview_options: { is_disabled: true },
    });
    expect(result.output[0]![0]).toMatchObject({ message_id: expect.any(Number), text: 'Hello <b>Bob</b>', chat: { id: 777 } });
  });

  it('works per item with expressions and sends nothing extra by default', async () => {
    await start();
    await saveCredential();
    const result = await run({ operation: 'sendMessage', chatId: '={{ $json.chat }}', text: '=Hi {{ $json.name }}' }, [{ chat: '1', name: 'Ann' }, { chat: '2', name: 'Bob' }]);
    expect(result.status).toBe('success');
    expect(tg.calls('sendMessage').map((c) => c.body)).toEqual([
      { chat_id: '1', text: 'Hi Ann' },
      { chat_id: '2', text: 'Hi Bob' },
    ]);
    expect(result.output[0]).toHaveLength(2);
  });

  it('sends a photo and a document from a URL / file id with caption', async () => {
    await start();
    await saveCredential();
    const photo = await run({ operation: 'sendPhoto', fileSource: 'url', fileUrl: 'https://example.com/a.jpg', caption: 'Look', parseMode: 'Markdown' });
    expect(photo.status).toBe('success');
    expect(tg.calls('sendPhoto')[0]!.body).toEqual({ chat_id: '555', photo: 'https://example.com/a.jpg', caption: 'Look', parse_mode: 'Markdown' });
    expect(photo.output[0]![0]).toMatchObject({ photo: [{ file_id: 'photo-1' }], caption: 'Look' });
    const doc = await run({ operation: 'sendDocument', fileSource: 'url', fileUrl: 'BQACAgQAAxkBAAI' });
    expect(doc.status).toBe('success');
    expect(tg.calls('sendDocument')[0]!.body).toEqual({ chat_id: '555', document: 'BQACAgQAAxkBAAI' });
  });

  it('edits, deletes, answers a callback query and gets a chat', async () => {
    await start();
    await saveCredential();
    const edit = await run({ operation: 'editMessageText', chatId: '9', messageId: '41', text: 'New text', parseMode: 'MarkdownV2' });
    expect(edit.output[0]![0]).toMatchObject({ message_id: 41, text: 'New text' });
    expect(tg.calls('editMessageText')[0]!.body).toEqual({ chat_id: '9', message_id: 41, text: 'New text', parse_mode: 'MarkdownV2' });

    const del = await run({ operation: 'deleteMessage', chatId: '9', messageId: '41' });
    expect(del.output[0]![0]).toEqual({ success: true });
    expect(tg.calls('deleteMessage')[0]!.body).toEqual({ chat_id: '9', message_id: 41 });

    const answer = await run({ operation: 'answerCallbackQuery', callbackQueryId: 'cb-1', answerText: 'Done!', showAlert: true });
    expect(answer.output[0]![0]).toEqual({ success: true });
    expect(tg.calls('answerCallbackQuery')[0]!.body).toEqual({ callback_query_id: 'cb-1', text: 'Done!', show_alert: true });

    const chat = await run({ operation: 'getChat', chatId: '9' });
    expect(chat.output[0]![0]).toMatchObject({ id: 9, type: 'private', first_name: 'Ada' });
    expect(tg.calls('getChat')[0]!.body).toEqual({ chat_id: '9' });
  });

  it('builds an inline keyboard (callback and url buttons, buttons per row)', async () => {
    await start();
    await saveCredential();
    const buttons = [
      { text: 'Yes', type: 'callback', value: 'yes:42' },
      { text: 'No', type: 'callback', value: 'no:42' },
      { text: 'Docs', type: 'url', value: 'https://example.com/docs' },
    ];
    const result = await run({ operation: 'sendMessage', text: 'Approve?', inlineKeyboard: { buttons }, buttonsPerRow: 2 });
    expect(result.status).toBe('success');
    expect(tg.calls('sendMessage')[0]!.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Yes', callback_data: 'yes:42' }, { text: 'No', callback_data: 'no:42' }], [{ text: 'Docs', url: 'https://example.com/docs' }]],
    });
    await run({ operation: 'editMessageText', messageId: '1', text: 'x', inlineKeyboard: { buttons: buttons.slice(0, 2) }, buttonsPerRow: 1 });
    expect(tg.calls('editMessageText')[0]!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Yes', callback_data: 'yes:42' }], [{ text: 'No', callback_data: 'no:42' }]] });
  });

  it('refuses a bad keyboard / parameters before any request', async () => {
    await start();
    await saveCredential();
    const long = await run({ operation: 'sendMessage', text: 'x', inlineKeyboard: { buttons: [{ text: 'A', type: 'callback', value: 'é'.repeat(33) }] } });
    expect(long.status).toBe('error');
    expect(long.error?.message).toMatch(/longer than 64 bytes/);
    const badUrl = await run({ operation: 'sendMessage', text: 'x', inlineKeyboard: { buttons: [{ text: 'A', type: 'url', value: 'nope' }] } });
    expect(badUrl.error?.message).toMatch(/URL of button "A" is not valid/);
    const empty = await run({ operation: 'sendMessage', text: '  ' });
    expect(empty.error?.message).toMatch(/text is empty/);
    const tooLong = await run({ operation: 'sendMessage', text: 'a'.repeat(4097) });
    expect(tooLong.error?.message).toMatch(/too long \(4097 characters, Telegram allows 4096\)/);
    const badId = await run({ operation: 'deleteMessage', messageId: 'abc' });
    expect(badId.error?.message).toMatch(/Message ID" must be a whole number/);
    const noCb = await run({ operation: 'answerCallbackQuery', callbackQueryId: '' });
    expect(noCb.error?.message).toMatch(/Callback Query ID/);
    expect(tg.requests).toHaveLength(0);
  });

  it('uploads a binary file as multipart/form-data (reply_markup as a JSON string)', async () => {
    await start();
    await saveCredential();
    const result = await run(
      { operation: 'sendDocument', chatId: '31', caption: 'The table', inlineKeyboard: { buttons: [{ text: 'OK', type: 'callback', value: 'ok' }] } },
      [{}],
      { before: [node('Make File', 'test.makeFile')] },
    );
    expect(result.status, JSON.stringify(result.error)).toBe('success');
    const call = tg.calls('sendDocument')[0]!;
    expect(call.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(call.body).toEqual({ chat_id: '31', caption: 'The table', reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'OK', callback_data: 'ok' }]] }) });
    expect(call.files).toHaveLength(1);
    expect(call.files[0]).toMatchObject({ field: 'document', fileName: 'table.csv' });
    expect(call.files[0]!.data.toString()).toBe('a,b\n1,2');
    expect(result.output[0]![0]).toMatchObject({ document: { file_name: 'table.csv' } });
  });

  it('sendPhoto from binary: clear error when the item has no such binary property', async () => {
    await start();
    await saveCredential();
    const result = await run({ operation: 'sendPhoto', binaryPropertyName: 'picture' });
    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('Item 0 has no binary property "picture"');
    expect(result.error?.hint).toMatch(/Binary properties of this item: none/);
    expect(tg.requests).toHaveLength(0);
  });
});

describe('Telegram node: credentials', () => {
  it('uses the Default Chat ID of the credential when Chat ID is empty', async () => {
    await start();
    await saveCredential({ chatId: '4242' });
    await run({ operation: 'sendMessage', text: 'hi' });
    expect(tg.calls('sendMessage')[0]!.body.chat_id).toBe('4242');
  });

  it('names TELEGRAM_CHAT_ID when neither the node nor the credential has a chat', async () => {
    await start();
    await saveCredential({ chatId: '' });
    const result = await run({ operation: 'sendMessage', text: 'hi' });
    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('No chat: "Chat ID" is empty');
    expect(result.error?.hint).toMatch(/Default Chat ID/);
    expect(result.error?.hint).toMatch(/TELEGRAM_CHAT_ID/);
    expect(tg.requests).toHaveLength(0);
  });

  it('falls back to the .env values when no credential is saved', async () => {
    await start({ TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: '808', TELEGRAM_API_URL: tg.url });
    const result = await run({ operation: 'sendMessage', text: 'from env' });
    expect(result.status, JSON.stringify(result.error)).toBe('success');
    expect(tg.calls('sendMessage')[0]!.body).toEqual({ chat_id: '808', text: 'from env' });
  });

  it('missing credential: names the credential type, the .env variable and the docs anchor', async () => {
    await start();
    const result = await run({ operation: 'sendMessage', text: 'hi' });
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ credentialType: 'telegramApi', envVar: 'TELEGRAM_BOT_TOKEN', docsAnchor: '#telegram' });
    expect(result.error?.hint).toMatch(/TELEGRAM_BOT_TOKEN/);
    expect(tg.requests).toHaveLength(0);
  });

  it('wrong token (401): a credential error pointing at the saved credential, without the token', async () => {
    await start();
    const saved = await saveCredential({ accessToken: '999:wrong-token-value' });
    const result = await run({ operation: 'sendMessage', text: 'hi' });
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ message: 'Telegram rejected the bot token', credentialType: 'telegramApi', credentialId: saved.id });
    expect(result.error?.hint).toMatch(/@BotFather/);
    expect(JSON.stringify(result)).not.toContain('wrong-token-value');
  });

  it('a malformed token (404 from Telegram) is also a credential error', async () => {
    await start();
    await saveCredential({ accessToken: 'no-colon-token' });
    const result = await run({ operation: 'sendMessage', text: 'hi' });
    expect(result.error).toMatchObject({ credentialType: 'telegramApi', message: 'Telegram rejected the bot token' });
  });

  it('the Test button calls getMe: "Connected as @bot (Name)." or a clear failure', async () => {
    await start();
    const good = await agent.post('/api/credentials/test').send({ type: 'telegramApi', data: { accessToken: TG_TOKEN, baseUrl: tg.url } });
    expect(good.body).toMatchObject({ ok: true, message: 'Connected as @flowforge_test_bot (FlowForge Bot).' });
    const bad = await agent.post('/api/credentials/test').send({ type: 'telegramApi', data: { accessToken: '1:nope', baseUrl: tg.url } });
    expect(bad.body).toMatchObject({ ok: false, message: 'Telegram rejected the bot token' });
    expect(bad.body.hint).toMatch(/BotFather/);
    const dead = await agent.post('/api/credentials/test').send({ type: 'telegramApi', data: { accessToken: TG_TOKEN, baseUrl: `http://127.0.0.1:${await closedPort()}` } });
    expect(dead.body.ok).toBe(false);
    expect(JSON.stringify(dead.body)).not.toContain(TG_TOKEN);
  });
});

describe('Telegram node: API errors', () => {
  it('400 "chat not found" and "can\'t parse entities" come with a hint', async () => {
    await start();
    await saveCredential();
    tg.script('sendMessage', { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } });
    const chat = await run({ operation: 'sendMessage', text: 'hi' });
    expect(chat.error?.message).toBe('Telegram refused the request: Bad Request: chat not found');
    expect(chat.error?.hint).toMatch(/press Start/);
    expect(chat.error?.credentialType).toBeUndefined();

    tg.script('sendMessage', { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 3" } });
    const parse = await run({ operation: 'sendMessage', text: 'a_b_*', parseMode: 'Markdown' });
    expect(parse.error?.message).toMatch(/can't parse entities/);
    expect(parse.error?.hint).toMatch(/Parse Mode to None/);
  });

  it('403 bot blocked by the user', async () => {
    await start();
    await saveCredential();
    tg.script('sendMessage', { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } });
    const result = await run({ operation: 'sendMessage', text: 'hi' });
    expect(result.error?.message).toBe('Telegram refused: Forbidden: bot was blocked by the user');
    expect(result.error?.hint).toMatch(/unblock/);
  });

  it('429 with a short retry_after is retried after the wait', async () => {
    await start();
    await saveCredential();
    tg.script('sendMessage', { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } } });
    const result = await run({ operation: 'sendMessage', text: 'hi' });
    expect(result.status).toBe('success');
    const calls = tg.calls('sendMessage');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(900);
  });

  it('429 with a long retry_after fails at once and says how long to wait', async () => {
    await start();
    await saveCredential();
    tg.script('sendMessage', { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 30', parameters: { retry_after: 30 } } });
    const result = await run({ operation: 'sendMessage', text: 'hi' });
    expect(result.error?.message).toBe('Telegram says there are too many requests');
    expect(result.error?.hint).toMatch(/30 seconds/);
    expect(tg.calls('sendMessage')).toHaveLength(1);
  });

  it('times out when Telegram does not answer', async () => {
    await start();
    await saveCredential();
    tg.script('sendMessage', { hang: true });
    const result = await run({ operation: 'sendMessage', text: 'hi', options: { timeout: 1 } });
    expect(result.status).toBe('error');
    expect(result.error?.message).toMatch(/^No answer from 127\.0\.0\.1:\d+ within 1 s$/);
  });

  it('a non-JSON or HTML answer gives a readable error', async () => {
    await start();
    await saveCredential();
    tg.script('sendMessage', { status: 200, raw: '<html>proxy page</html>' });
    const ok = await run({ operation: 'sendMessage', text: 'hi' });
    expect(ok.error?.message).toBe('Telegram sent an answer that is not valid JSON');
    expect(ok.error?.hint).toMatch(/Base URL/);
    tg.script('sendMessage', { status: 502, raw: '<html>Bad gateway</html>' });
    const bad = await run({ operation: 'sendMessage', text: 'hi' });
    expect(bad.error?.message).toBe('Telegram answered HTTP 502 without a readable body');
  });

  it('a 500 is a plain error; connection refused names the host, not the token', async () => {
    await start();
    await saveCredential();
    tg.script('sendMessage', { status: 500, body: { ok: false, error_code: 500, description: 'Internal Server Error' } });
    const result = await run({ operation: 'sendMessage', text: 'hi' });
    expect(result.error?.message).toBe('Telegram answered with an error: Internal Server Error');
    expect(result.error?.hint).toMatch(/Retry On Fail/);
    await agent.delete(`/api/credentials/${(await agent.get('/api/credentials')).body[0].id}`);
    await saveCredential({ baseUrl: `http://127.0.0.1:${await closedPort()}` });
    const refused = await run({ operation: 'sendMessage', text: 'hi' });
    expect(refused.error?.message).toMatch(/^Connection refused by 127\.0\.0\.1:\d+$/);
  });

  it('"Continue On Fail" turns an API error into an item', async () => {
    await start();
    await saveCredential();
    tg.script('sendMessage', { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } });
    const result = await run({ operation: 'sendMessage', text: 'hi' }, [{}], { settings: { onError: 'continueRegularOutput' } });
    expect(result.status).toBe('success');
    expect(JSON.stringify(result.output)).toMatch(/chat not found/);
  });

  it('the bot token never appears in the result, the errors or the logs', async () => {
    await start();
    await saveCredential();
    const all: unknown[] = [];
    all.push(await run({ operation: 'sendMessage', text: 'ok' }));
    // A server that echoes the URL (with the token) in its error text.
    tg.script('sendMessage', { status: 400, body: { ok: false, error_code: 400, description: `Bad Request: bad url /bot${TG_TOKEN}/sendMessage` } });
    const echoed = await run({ operation: 'sendMessage', text: 'hi' });
    expect(echoed.error?.message).toContain('***');
    all.push(echoed);
    tg.script('sendMessage', { status: 500, body: { ok: false, error_code: 500, description: TG_TOKEN } });
    all.push(await run({ operation: 'sendMessage', text: 'hi' }));
    all.push(await run({ operation: 'sendPhoto', binaryPropertyName: 'x' }));
    for (const r of all) expect(JSON.stringify(r)).not.toContain(TG_TOKEN);
    const stored = JSON.stringify(t.ctx.executionsRepo.list({ limit: 100 }));
    expect(stored).not.toContain(TG_TOKEN);
    expect(logger.lines.join('\n')).not.toContain(TG_TOKEN);
    expect(logger.lines.join('\n')).not.toContain(TG_TOKEN.split(':')[1]!);
  });
});

describe('Telegram client helpers', () => {
  it('describeTelegramError redacts the token in every text', () => {
    const e = describeTelegramError('sendMessage', 400, { ok: false, error_code: 400, description: `oops ${TG_TOKEN}` }, TG_TOKEN);
    expect(e).toBeInstanceOf(IntegrationError);
    expect(`${e.message} ${e.hint ?? ''}`).not.toContain(TG_TOKEN);
    expect(describeTelegramError('getUpdates', 409, {}, TG_TOKEN)).toMatchObject({ message: 'Another program is reading the updates of this bot', status: 409 });
    expect(describeTelegramError('sendMessage', 401, { error_code: 401 }, TG_TOKEN).auth).toBe(true);
    expect(describeTelegramError('sendMessage', 429, { error_code: 429, parameters: { retry_after: 7 } }, TG_TOKEN).retryAfterMs).toBe(7000);
  });

  it('telegramCall refuses an empty token and a bad base URL without leaking either', async () => {
    await expect(telegramCall({ token: '  ' }, 'getMe')).rejects.toMatchObject({ message: 'The bot token is empty', auth: true });
    await expect(telegramCall({ token: TG_TOKEN, baseUrl: 'ftp://x' }, 'getMe')).rejects.toThrow(/must start with http/);
    await expect(telegramCall({ token: TG_TOKEN, baseUrl: 'not a url' }, 'getMe')).rejects.not.toThrow(TG_TOKEN);
  });

  it('turns updates into items: chatId, text, command and args', () => {
    const msg = (text: string) => ({ update_id: 1, message: { message_id: 1, from: { id: 42 }, chat: { id: -100123 }, text } });
    expect(updateToItem(msg('/weather Paris')).json).toMatchObject({ chatId: -100123, text: '/weather Paris', command: 'weather', args: 'Paris', update_id: 1 });
    expect(updateToItem(msg('/weather@FlowBot  New York ')).json).toMatchObject({ command: 'weather', args: 'New York' });
    expect(updateToItem(msg('/start')).json).toMatchObject({ command: 'start', args: '' });
    const plain = updateToItem(msg('hello /weather')).json;
    expect(plain).toMatchObject({ text: 'hello /weather' });
    expect(plain.command).toBeUndefined();
    const callback = updateToItem({ update_id: 2, callback_query: { id: 'cb', from: { id: 7 }, data: 'yes:42', message: { message_id: 5, chat: { id: 99 } } } });
    expect(callback.json).toMatchObject({ chatId: 99, text: 'yes:42' });
    expect(callback.json.command).toBeUndefined();
    expect(callback.userId).toBe('7');
  });
});
