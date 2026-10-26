# Phase 5 contracts (one section per integration)

Endpoints, limits and error shapes below were checked against the official docs on 2026-10-12 (and with
no-key calls for the error bodies). **Do not add an endpoint or a parameter that is not listed here.**

## Common rules (all workers)

**Pattern to copy** (read these, nothing else unless your contract names it):

| What | File |
|---|---|
| Node file (credentials, `forEachItem`, errors) | `server/src/nodes/integrations/send-email.node.ts` |
| Node with `fixedCollection`, options collection, binary in/out | `server/src/nodes/network/http-request.node.ts` (skim) |
| HTTP calls: `httpSend()`, `redact()` | `server/src/nodes/_shared/http-client.ts` |
| Client errors: `IntegrationError`, `toNodeError()` | `server/src/integrations/errors.ts` |
| Credential type with `test()` | `server/src/credentials/smtp.credential.ts`, `types.ts` |
| Test style (app + dev run API) | `server/tests/send-email.test.ts`, `server/tests/trigger-helpers.ts`, `server/tests/helpers.ts` |
| Local mock server style | `server/tests/http-mock.ts` |

**Files per integration** (names are fixed):

- `server/src/integrations/<name>.ts`: the client. Header comment with the official docs URL(s). Pure functions,
  no engine imports except `IntegrationError`, `httpSend`, `redact`. Every function takes
  `{ signal?: AbortSignal; timeoutMs?: number }` last. Non-2xx / API error ⇒ throw `IntegrationError(service,
  message, { status, code, hint, auth, retryAfterMs })` with a plain-words message and a hint that says what to do.
  `auth: true` when the key / token / URL is wrong. **Pass every server text through `redact(text, [secret])`.**
  Network failures from `httpSend` (already clear `NodeOperationError`s) pass through; give `httpSend` the secret
  in `secrets` (tokens in URLs!).
- `server/src/nodes/integrations/<name>.node.ts`: `export default defineNode({...})`, auto-registered. Type
  `flowforge.<camelCase>`, `group: 'integration'`, icon given below. Per-item work in `ctx.forEachItem()`.
  Errors: `throw toNodeError(err, { credentialType, credential, envVars, docsAnchor, itemIndex })`.
  Parameter problems (empty required value…): `NodeOperationError` with a hint, thrown BEFORE any network call.
- `server/src/credentials/<file>.credential.ts`: already created with its properties. **Only add `test()`**
  (it must call the client, return `{ ok, message, hint? }`, and never throw for an expected failure).
  Do NOT edit `registry.ts`.
- `server/tests/<name>-mock.ts` (local mock server on `127.0.0.1`, port 0, records requests) and
  `server/tests/<name>.test.ts`.

**Rules**

- Missing credential: just call `await ctx.getCredentials('<type>')`: it throws `MissingCredentialError` with the
  env var name and the docs anchor. Test it (`error.credentialType`, `error.envVar`, hint mentions the variable).
- Secrets (token, key, webhook URL) never appear in output items, error messages, hints, logs or `addLog`.
  Add one test that greps the whole run result (`JSON.stringify`) for the secret.
- Tests use ONLY the local mock: success, 4xx, 429, timeout, malformed (non-JSON) answer. No real network.
- Node 20.11 compatible. No new dependency (undici 6 `fetch` / `FormData` are available through `httpSend`).
- Other workers edit the repo at the same time. Touch only your files. Do not re-read the whole repo. Do not run
  the full suite: `cd server && npx vitest run tests/<name>.test.ts`. Typecheck at the end with
  `cd server && npx tsc --noEmit -p .` and fix only errors in YOUR files.
- Final report, 5 lines max: files changed, tests passing (count), open issues.

---

## W1 Telegram

Docs: <https://core.telegram.org/bots/api> (Making requests, getUpdates, Available methods).

**Credential** `telegramApi` (`telegram-api.credential.ts`): `accessToken` (`TELEGRAM_BOT_TOKEN`), `chatId`
(`TELEGRAM_CHAT_ID`, optional default chat), `baseUrl` (default `https://api.telegram.org`; tests point it to the
mock). `test()` = `getMe` ⇒ `Connected as @<username> (<first_name>).`

**API facts**

- `POST {baseUrl}/bot<token>/<method>`, JSON body (multipart/form-data when a file is uploaded; then
  `reply_markup` is a JSON string). Answer: `{ ok: true, result }` or `{ ok: false, error_code, description,
  parameters?: { retry_after (seconds), migrate_to_chat_id } }`.
- Methods allowed: `getMe`, `getUpdates` (`offset`, `limit` 1–100, `timeout` seconds, `allowed_updates`),
  `deleteWebhook` (`drop_pending_updates`), `sendMessage` (`chat_id`, `text` 1–4096, `parse_mode`,
  `link_preview_options: { is_disabled }`, `disable_notification`, `protect_content`,
  `reply_parameters: { message_id }`, `message_thread_id`, `reply_markup`), `sendPhoto` (`photo`, `caption` ≤ 1024,
  `parse_mode`, …), `sendDocument` (`document`, `caption`, `parse_mode`, …; up to 50 MB), `editMessageText`
  (`chat_id`, `message_id`, `text`, `parse_mode`, `reply_markup`), `deleteMessage` (`chat_id`, `message_id`),
  `answerCallbackQuery` (`callback_query_id`, `text` ≤ 200, `show_alert`, `cache_time`), `getChat` (`chat_id`).
- `parse_mode`: `HTML`, `Markdown` (legacy), `MarkdownV2`. Inline keyboard: `reply_markup: { inline_keyboard:
  [[{ text, callback_data (1–64 bytes) } | { text, url }]] }`.
- Errors seen: wrong token ⇒ HTTP 401 `{"ok":false,"error_code":401,"description":"Unauthorized"}` (404 for a
  malformed token) ⇒ `auth: true`. 400 `Bad Request: chat not found` ⇒ hint: the user must press Start in the bot
  first / check Chat ID. 400 `can't parse entities` ⇒ hint: escape the text or set Parse Mode to None. 403 `bot was
  blocked by the user`. 429 ⇒ `retryAfterMs` from `parameters.retry_after`; the client waits and retries when it is
  ≤ 10 s (max 2 retries), else throws. 409 on `getUpdates` ⇒ another program polls this bot.

**Client** `integrations/telegram.ts`: `telegramCall<T>(auth: { token, baseUrl? }, method, params?, o?)`,
plus thin `getMe`, and `describeTelegramError`. The token is in the URL: always in `secrets`.

**TelegramHub** `integrations/telegram-hub.ts`: `class TelegramHub` + exported singleton `telegramHub`.

- `subscribe({ token, baseUrl, startOffset?: number, skipBacklog: boolean, onUpdate(update), onError(err),
  onOffset?(nextOffset) }): Promise<{ close(): Promise<void> }>`.
- **Exactly ONE poll loop per `baseUrl + token`**, shared by all subscribers (fan-out, each subscriber gets every
  update once). Never two `getUpdates` in flight for a token (that is what causes 409). The loop starts with the
  first subscriber and stops (in-flight request aborted, promise awaited) when the last one closes.
- Loop start: `getMe` (throws ⇒ `subscribe` rejects, so activation fails with a clear message) → `deleteWebhook`
  (`drop_pending_updates: false`) → if no start offset and `skipBacklog`: `getUpdates({ offset: -1, timeout: 0 })`
  and continue after that update (old messages do not fire) → loop `getUpdates({ offset, timeout: 25, limit: 100,
  allowed_updates: ['message','edited_message','channel_post','edited_channel_post','callback_query'] })`
  (HTTP timeout = poll timeout + 10 s).
- After each batch: `offset = max(update_id) + 1`, call every subscriber's `onOffset(offset)`, then fan out.
  A subscriber joining a running loop with a higher `startOffset` does not move the offset backwards.
- Failures: exponential backoff 1 s, 2 s, 4 s … max 60 s, reset after a success; 429 waits `retry_after`.
  Report to `onError` once per failure streak (not every retry): 409 ⇒ `IntegrationError('Another program is
  reading the updates of this bot', hint: 'Only one program can poll a bot. Stop the other one (another FlowForge,
  n8n, a script) or create a second bot with @BotFather.')`; 401 ⇒ auth error and the loop stops.
- Timings are constructor options (`pollTimeoutSeconds`, `backoffBaseMs`, `backoffMaxMs`) so tests are fast;
  `telegramHub.configure(partial)` for the singleton.

**Node** `telegram.node.ts`: `flowforge.telegram`, "Telegram", icon `lucide:send`, credentials
`[{ type: 'telegramApi', required: true }]`. `operation` options: `sendMessage` (default), `sendPhoto`,
`sendDocument`, `editMessageText`, `deleteMessage`, `answerCallbackQuery`, `getChat`.

- `chatId` (string, shown for all but answerCallbackQuery; empty ⇒ credential `chatId`; still empty ⇒
  NodeOperationError naming `TELEGRAM_CHAT_ID` and the credential field "Default Chat ID").
- `text` (sendMessage, editMessageText), `parseMode` options `none` (default) | `HTML` | `Markdown` | `MarkdownV2`.
- sendPhoto / sendDocument: `fileSource` `binary` (default) | `url`; `binaryPropertyName` (default `data`) or
  `fileUrl` (URL or file_id); `caption`.
- `messageId` (edit, delete), `callbackQueryId` + `answerText` + `showAlert` (answerCallbackQuery).
- Inline keyboard (sendMessage, sendPhoto, sendDocument, editMessageText): `inlineKeyboard` fixedCollection,
  multiple `buttons` `{ text, type: 'callback' | 'url', value }` + `buttonsPerRow` (number, default 2).
- `options` collection: `disableNotification`, `disableLinkPreview`, `protectContent`, `replyToMessageId`,
  `messageThreadId`, `timeout` (seconds, default 30).
- Output: the API `result` (the sent Message object for send/edit; `{ success: true }` when the result is `true`).

**Trigger** `nodes/triggers/telegram-trigger.node.ts`: `flowforge.telegramTrigger`, "Telegram Trigger", icon
`lucide:send`, `group: 'trigger'`, `trigger: { kind: 'listener' }`, same credential. Copy the shape of
`nodes/triggers/local-file-trigger.node.ts`. `TriggerContext` has `getCredentials(type)` (sync),
`getStaticData()`, `saveStaticData()`, `mode` (`'manual'` = test listener).

- `updates` multiOptions: `message` (default), `edited_message`, `channel_post`, `callback_query`, `*`.
- `options`: `command` (e.g. `/weather`; only messages starting with that command, `/weather@BotName` accepted),
  `chatIds` (comma-separated allow list), `userIds`.
- Emits one item per update: the raw Update object plus `chatId`, `text`, and for commands `command`
  (`"weather"`) and `args` (`"Paris"`): `/weather Paris` ⇒ `{ command: 'weather', args: 'Paris' }`.
  For `callback_query`: `chatId` = `callback_query.message.chat.id`, `text` = `callback_query.data`.
- `trigger(ctx)`: `telegramHub.subscribe({ startOffset: staticData.offset, skipBacklog: true, onOffset: (o) => {
  staticData.offset = o; ctx.saveStaticData(); }, onError: ctx.emitError, onUpdate })`. In `mode === 'manual'`
  ignore the stored offset.

**Tests** (`telegram.test.ts`, mock `telegram-mock.ts` implementing the methods above incl. long polling that
answers within ≤ 200 ms): every operation golden path, inline keyboard payload, multipart upload of a binary
file, default chat id fallback, missing credential, 401, 400 parse error, 429 with retry, timeout, malformed
answer, secret never in the result. Hub: ONE poller for 2 subscribers (the mock counts concurrent `getUpdates`,
max must be 1) and both receive each update once; offset sent = last id + 1 and persisted in static data across
deactivate/activate; backlog skipped on first start; backoff after 500s then recovery; 409 ⇒ one `onError` with
the "Another program" message; clean shutdown (no request after close); activate/deactivate twice ⇒ no
duplicate executions for one update; command filter; test listener (`POST /api/workflows/:id/test-listen`,
see `server/tests/triggers.test.ts` for how a listener trigger is test-listened) runs once.

---

## W2 Discord

Docs: <https://docs.discord.com/developers/resources/webhook>, <https://docs.discord.com/developers/resources/message>
(embed object + limits), <https://docs.discord.com/developers/topics/rate-limits>.

**Credential** `discordWebhookApi` (`discord-webhook-api.credential.ts`): `webhookUri` (`DISCORD_WEBHOOK_URL`).
`test()` = `GET <webhook url>` (posts nothing) ⇒ `Webhook "<name>" is reachable.` The GET answer contains the
token: never return or log it.

**API facts**

- URL form `https://discord.com/api/webhooks/{webhook.id}/{webhook.token}` (also `discordapp.com`, `/api/v10/`).
  Validate the shape (`/webhooks/<digits>/<token>` in the path) before any call; otherwise `IntegrationError`
  with `auth: true` and a hint showing the expected form. Strip any query string the user pasted.
- Get: `GET {url}` → webhook object (`id`, `name`, `channel_id`, `guild_id`, `token`).
- Execute: `POST {url}?wait=true` (+ `thread_id`) JSON `{ content, username, avatar_url, tts, embeds, flags }`.
  `wait=true` ⇒ 200 + Message object; without it 204 and no body. At least one of `content` / `embeds` is needed.
- Edit: `PATCH {url}/messages/{message.id}` JSON `{ content, embeds }` → Message. Delete: `DELETE
  {url}/messages/{message.id}` → 204. Get message: `GET {url}/messages/{message.id}`. All accept `thread_id`.
- Limits: `content` ≤ 2000 chars; ≤ 10 embeds; embed `title` 256, `description` 4096, ≤ 25 fields, field `name`
  256, field `value` 1024, `footer.text` 2048, `author.name` 256, and 6000 chars summed over all embeds.
  `flags`: `SUPPRESS_EMBEDS` = 4, `SUPPRESS_NOTIFICATIONS` = 4096.
- Embed object: `title`, `description`, `url`, `timestamp` (ISO 8601), `color` (integer), `footer { text,
  icon_url }`, `image { url }`, `thumbnail { url }`, `author { name, url, icon_url }`, `fields [{ name, value,
  inline }]`.
- Errors: unknown webhook ⇒ 404 `{"message":"Unknown Webhook","code":10015}`, bad token ⇒ 401 `{"message":"Invalid
  Webhook Token","code":50027}` (both `auth: true`, hint: the webhook was deleted or the URL is incomplete).
  400 ⇒ validation details in the JSON body (show them). 429 ⇒ body `{ message, retry_after (seconds, float),
  global }` + `Retry-After` header: wait and retry (max 3 tries, only when the wait is ≤ 10 s, abortable), else
  `IntegrationError` with `retryAfterMs` and the hint "Discord asks to wait N s".

**Client** `integrations/discord.ts`: `parseWebhookUrl`, `getWebhook`, `executeWebhook`, `editWebhookMessage`,
`deleteWebhookMessage`, `getWebhookMessage`, `buildEmbed`, `checkLimits`.

**Node** `discord.node.ts`: `flowforge.discord`, "Discord", icon `lucide:message-circle-more`, credentials
`[{ type: 'discordWebhookApi', required: true }]`. `operation`: `sendMessage` (default), `editMessage`,
`deleteMessage`, `getMessage`.

- `content` (string, rows), `embeds` fixedCollection (multiple `embed`): `title`, `description`, `url`, `color`
  (property type `color`, hex `#5865F2` ⇒ integer), `authorName`, `authorUrl`, `authorIconUrl`, `thumbnailUrl`,
  `imageUrl`, `footerText`, `footerIconUrl`, `timestamp` (`none` | `now` | `custom` + `timestampValue`), and
  `fieldsJson` (JSON array `[{ "name", "value", "inline" }]`, default `[]`; a nested fixedCollection is not
  supported by the editor). Embeds with nothing set are dropped.
- `messageId` (edit / delete / get).
- `options`: `username`, `avatarUrl`, `tts`, `threadId`, `suppressEmbeds`, `suppressNotifications`, `wait`
  (default true), `longContent` `error` (default) | `truncate` (cut at 2000 with "…"), `timeout` (seconds, 30).
- Limits are checked before sending: clear NodeOperationError naming the limit and the actual size
  (`The message is 2314 characters long; Discord allows 2000`), never a raw 400.
- Output: the Message object (`id`, `channel_id`, `content`, `embeds`, `timestamp`…) for send (wait) / edit / get;
  `{ success: true }` for send without wait; `{ success: true, messageId }` for delete.

**Tests** (`discord.test.ts`, mock `discord-mock.ts`): send content, send with username/avatar, full embed (color
hex ⇒ int, fields, timestamp now), `?wait=true` present / absent, thread_id, edit, delete, get; 2001 chars ⇒ error
before any request and `truncate`; 11 embeds; 6000 total; 429 then success honouring `retry_after` (mock answers
429 with `retry_after: 0.05` once) and 429 with a long wait ⇒ error; 404 / 401 ⇒ CredentialError with
`credentialId`; 400 with details; timeout; malformed answer; missing credential (env var `DISCORD_WEBHOOK_URL`
in the error); `.env` fallback (`makeTestApp({}, { env: { DISCORD_WEBHOOK_URL } })`); credential Test button
(`POST /api/credentials/test`) does a GET and posts nothing; the webhook URL / token never in the run result.

---

## W3 Open-Meteo (no key)

Docs: <https://open-meteo.com/en/docs> (forecast), <https://open-meteo.com/en/docs/geocoding-api>,
<https://open-meteo.com/en/terms> (free for non-commercial use: < 10 000 calls/day, 5 000/hour, 600/minute;
data CC BY 4.0, attribution required).

**API facts**

- Geocoding: `GET https://geocoding-api.open-meteo.com/v1/search?name=&count=(1–100, default 10)&language=(en)&
  format=json&countryCode=(ISO alpha-2)`. Answer `{ results: [{ id, name, latitude, longitude, elevation,
  timezone, feature_code, country, country_code, admin1…admin4, population }] }`. **No match ⇒ `results` is
  absent** (`{"generationtime_ms":0.5}`), HTTP 200. Names shorter than 2 characters return nothing.
- Forecast: `GET https://api.open-meteo.com/v1/forecast?latitude=&longitude=&current=…&hourly=…&daily=…&
  temperature_unit=celsius|fahrenheit&wind_speed_unit=kmh|ms|mph|kn&precipitation_unit=mm|inch&timezone=auto|<tz>&
  forecast_days=0–16&forecast_hours=N`. Lists are comma-separated.
- Variables to request (all verified): current `temperature_2m, relative_humidity_2m, apparent_temperature,
  is_day, precipitation, weather_code, cloud_cover, wind_speed_10m, wind_direction_10m, wind_gusts_10m`;
  hourly `temperature_2m, apparent_temperature, relative_humidity_2m, precipitation_probability, precipitation,
  weather_code, wind_speed_10m, is_day`; daily `weather_code, temperature_2m_max, temperature_2m_min,
  apparent_temperature_max, apparent_temperature_min, sunrise, sunset, uv_index_max, precipitation_sum,
  precipitation_probability_max, wind_speed_10m_max`.
- Answer: `latitude, longitude, elevation, utc_offset_seconds, timezone, timezone_abbreviation, current_units,
  current { time, interval, <vars> }, hourly_units, hourly { time[], <var>[] }, daily_units, daily { time[],
  <var>[] }`. Units come from the `*_units` objects (`°C`, `km/h`, `mp/h`, `mm`, `inch`, `%`).
- Errors: HTTP 400 `{ "error": true, "reason": "Latitude must be in range of -90 to 90°. Given: 948.85." }`.
- WMO `weather_code`: 0 Clear sky ☀️ (night 🌙) · 1 Mainly clear 🌤️ · 2 Partly cloudy ⛅ · 3 Overcast ☁️ ·
  45 Fog 🌫️ · 48 Depositing rime fog 🌫️ · 51/53/55 Light/Moderate/Dense drizzle 🌦️ · 56/57 Light/Dense freezing
  drizzle 🌧️ · 61/63/65 Slight/Moderate/Heavy rain 🌧️ · 66/67 Light/Heavy freezing rain 🌧️ · 71/73/75
  Slight/Moderate/Heavy snowfall 🌨️ · 77 Snow grains 🌨️ · 80/81/82 Slight/Moderate/Violent rain showers 🌦️ ·
  85/86 Slight/Heavy snow showers 🌨️ · 95 Thunderstorm ⛈️ · 96 Thunderstorm with slight hail ⛈️ · 97 Heavy
  thunderstorm ⛈️ · 99 Thunderstorm with heavy hail ⛈️. Unknown code ⇒ `Unknown (code N)` 🌡️.

**Client** `integrations/open-meteo.ts`: `geocode(name, { count, language, countryCode, baseUrl }, o)`,
`forecast(params, o)`, `describeWeatherCode(code, isDay)` ⇒ `{ description, emoji }`, `summarize(...)`.
Default base URLs as above; both overridable (Open-Meteo can be self-hosted; tests use the mock).

**Node** `open-meteo.node.ts`: `flowforge.openMeteo`, "Weather (Open-Meteo)", icon `lucide:cloud-sun`, no
credentials. `operation`: `getWeather` (default) | `searchLocation`.

- `locationMode` `city` (default) | `coordinates`; `city` (string, e.g. `Paris` or `Paris, France`); `latitude`,
  `longitude` (numbers; validate ranges before calling).
- `include` multiOptions `current`, `daily`, `hourly` (default `['current', 'daily']`); `forecastDays` (1–16,
  default 3); `hourlyHours` (1–168, default 24, shown when hourly is included; sent as `forecast_hours`).
- `temperatureUnit`, `windSpeedUnit`, `precipitationUnit` (values above), `timezone` (string, default `auto`).
- `options`: `language` (default `en`), `countryCode`, `forecastUrl`, `geocodingUrl`, `timeout` (seconds, 15).
- searchLocation: `query` (place name) + `limit` (default 5) ⇒ one item per place.
- The name is sent to the API exactly as typed: the API resolves `Paris, Texas` or `Springfield, IL` itself (checked live).
- getWeather output (one item per input item), camelCase and readable:
  `location { name, country, countryCode, region, latitude, longitude, timezone, elevation }`,
  `current { time, temperature, feelsLike, humidity, precipitation, cloudCover, windSpeed, windDirection,
  windGusts, isDay, weatherCode, description, emoji }`,
  `daily [{ date, weatherCode, description, emoji, temperatureMax, temperatureMin, feelsLikeMax, feelsLikeMin,
  sunrise, sunset, uvIndexMax, precipitationSum, precipitationProbability, windSpeedMax }]`,
  `hourly [{ time, temperature, feelsLike, humidity, precipitationProbability, precipitation, weatherCode,
  description, emoji, windSpeed, isDay }]`,
  `units { temperature, windSpeed, precipitation }`,
  `summary` (one readable line, e.g. `Paris, France: ⛅ Partly cloudy, 19.8 °C (feels like 18.4 °C), wind
  11 km/h. Today 12.1 to 20.6 °C, rain 20 %.`), `attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)'`.
- Errors: empty city; city not found (`No place found for "Xyzzy"`, hint: check spelling, add the country, or use
  coordinates); 400 ⇒ the API `reason`; 429 / 5xx; timeout; malformed answer.

**Tests** (`open-meteo.test.ts`, mock `open-meteo-mock.ts` serving both endpoints with fixed data): city ⇒
geocode + forecast + summary; coordinates skip geocoding; each `include` combination requests only its blocks;
units are sent and reflected in `units` and `summary`; timezone sent; weather-code text/emoji incl. night and
unknown code; searchLocation; not found; 1-letter name; bad latitude; 400 reason; 429; 500; timeout; malformed;
per-item error with `onError: continueRegularOutput`; `describeWeatherCode` table unit test.

---

## W4 Gemini

Docs: <https://ai.google.dev/api/generate-content>, <https://ai.google.dev/gemini-api/docs/models>,
<https://ai.google.dev/gemini-api/docs/api-key>, <https://ai.google.dev/gemini-api/docs/troubleshooting>.

**Credential** `googlePalmApi` (`google-gemini-api.credential.ts`): `apiKey` (`GEMINI_API_KEY`), `model`
(`GEMINI_MODEL`, default `gemini-3.8-flash`), `host` (default `https://generativelanguage.googleapis.com`; tests
point it to the mock). `test()` = a tiny prompt (`Reply with the single word OK.`, no token limit) on the
credential's model ⇒ `The key works (model gemini-3.8-flash answered).`

**API facts**

- `POST {host}/v1beta/models/{model}:generateContent`, header `x-goog-api-key: <key>` (never the `?key=` query),
  `Content-Type: application/json`.
- Body: `{ contents: [{ role: 'user' | 'model', parts: [{ text } | { inlineData: { mimeType, data: <base64> } }] }],
  systemInstruction: { parts: [{ text }] }, generationConfig: { temperature, maxOutputTokens, topP, topK,
  responseMimeType: 'application/json' } }`. Do not send other fields.
- Answer: `{ candidates: [{ content: { parts: [{ text, thought? }] }, finishReason }], promptFeedback: {
  blockReason }, usageMetadata: { promptTokenCount, candidatesTokenCount, thoughtsTokenCount, totalTokenCount },
  modelVersion }`. Text = the `text` of the parts that are not `thought: true`, joined.
- `finishReason`: `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `LANGUAGE`, `OTHER`, `BLOCKLIST`,
  `PROHIBITED_CONTENT`, `SPII`, … `blockReason`: `SAFETY`, `OTHER`, `BLOCKLIST`, `PROHIBITED_CONTENT`,
  `IMAGE_SAFETY`.
- Models with a free tier (2026-10): `gemini-3.8-flash` (default), `gemini-3.6-flash`, `gemini-3.5-flash-lite`,
  `gemini-3.1-flash-lite`. Free limits are per project and only visible in AI Studio: do not hardcode numbers.
- Error body (verified): `{ "error": { "code": 400, "message": "API key not valid. Please pass a valid API key.",
  "status": "INVALID_ARGUMENT", "details": [{ "reason": "API_KEY_INVALID" }, …] } }`. The newer docs also show
  `{ "error": { "code": "invalid_request", "message" } }` (string code): accept both.
  - 400 + `API_KEY_INVALID` (or message "API key not valid") ⇒ `auth: true`, "The Gemini API key is not valid".
  - 400 other ⇒ the API message; hint to check the model and the parameters.
  - 401 / 403 ⇒ `auth: true`, "The Gemini API key is missing a permission" + API message.
  - 404 ⇒ `The model "<x>" does not exist`, hint with the model list above.
  - 429 ⇒ "Gemini rate limit reached"; `retryAfterMs` from `details[].retryDelay` (`"12s"`) when present; the
    client retries (429 with a wait ≤ 15 s, and 500/503 after 1 s then 2 s; `maxRetries` default 2, abortable).
  - `promptFeedback.blockReason` ⇒ "Gemini blocked the prompt (SAFETY)". No text and `finishReason` SAFETY /
    RECITATION / PROHIBITED_CONTENT / BLOCKLIST / SPII ⇒ "Gemini stopped the answer (SAFETY)". No text and
    `MAX_TOKENS` ⇒ hint: raise Max Output Tokens (thinking tokens count). `MAX_TOKENS` with text ⇒ return it.

**Client** `integrations/gemini.ts`: `generateContent(auth: { apiKey, host? }, request: { model, prompt,
history?: { role: 'user' | 'model'; text: string }[], systemInstruction?, images?: { mimeType, data: Buffer }[],
temperature?, maxOutputTokens?, topP?, topK?, json?: boolean, maxRetries? }, o)` ⇒ `{ text, json?, model,
finishReason, usage: { promptTokens, outputTokens, thoughtsTokens, totalTokens } }`. `GEMINI_MODELS` list export.
In JSON mode parse the text (strip a ```json fence if the model adds one); unparsable ⇒ IntegrationError with
the first 200 chars.

**Node** `google-gemini.node.ts`: `flowforge.googleGemini`, "Google Gemini", icon `lucide:sparkles`, credentials
`[{ type: 'googlePalmApi', required: true }]`.

- `model` options: `default` ("Default (credential / GEMINI_MODEL)"), the four ids above, `custom` +
  `customModel` (string).
- `prompt` (string, rows 5, required; empty ⇒ NodeOperationError with a hint), `systemInstruction` (string, rows 3).
- `jsonOutput` (boolean "JSON Mode": the parsed object is in `json`).
- `sendImages` (boolean) + `binaryPropertyName` (default `data`, comma-separated for several). Only `image/*`
  (else a clear error naming the mime type); total inline size > 15 MB ⇒ clear error before calling.
- `options`: `temperature` (0–2), `maxOutputTokens`, `topP`, `topK`, `maxRetries` (default 2), `timeout`
  (seconds, default 60).
- Output per item: `{ text, json?, model, finishReason, usage }`. **The orchestrator adds conversation memory
  later**: keep the request building in one small function that accepts `history`.

**Tests** (`gemini.test.ts`, mock `gemini-mock.ts`): text answer; header `x-goog-api-key` sent and no `key=` in
the URL; system instruction + generationConfig mapping; JSON mode (`responseMimeType`, parsed `json`, fenced
JSON, invalid JSON); image from binary (`inlineData.mimeType` + base64 equals the file); non-image binary;
default model from credential, from `GEMINI_MODEL` env, custom model; history sent as `contents`; thought parts
skipped; 400 invalid key ⇒ CredentialError (`credentialId`, env hint when from `.env`); 400 other; 403; 404
model; 429 retried then OK; 429 with a long delay ⇒ error with the wait; 503 retried; safety block
(`promptFeedback`); `finishReason: SAFETY`; `MAX_TOKENS` empty; timeout; malformed; missing credential (env var
`GEMINI_API_KEY`); credential Test button; the API key never in the run result or captured logs.
