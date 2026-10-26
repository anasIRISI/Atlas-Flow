# API setup: keys and logins for the integrations

Every integration works in two ways. Pick one:

| Where | When to use it |
|---|---|
| **Credentials page** in FlowForge (encrypted, with a Test button) | Recommended. Several accounts possible, chosen per node. |
| **`.env` file** in the project folder | Fallback when no credential is saved. Handy for a quick demo. |

FlowForge looks for a credential in this order: the one **selected on the node** → the **default** credential
of that type → the **`.env`** variables → otherwise the node fails with a clear "credentials are missing"
error and an **Open Credentials** button.

Secrets are stored encrypted (AES-256-GCM) in `data/flowforge.db`. The key is in `data/.encryption_key`
(or `FLOWFORGE_ENCRYPTION_KEY` in `.env`). **Back up that file with the database**: without it, saved
credentials cannot be read and must be typed again. Secrets are never shown again after saving, and never
written to executions or logs.

Sections: [Verify everything](#verify-everything-npm-run-check) · [Email (SMTP)](#email-smtp) · [Form](#form) ·
[Telegram](#telegram) · [Discord](#discord) · [Google Gemini](#google-gemini) · [Weather (Open-Meteo)](#weather-open-meteo) ·
[Chat](#chat) · [Webhook authentication](#webhook-authentication) ·
[HTTP Request authentication](#http-request-authentication) · [Troubleshooting](#troubleshooting)

For a single checklist of everything to prepare, see [need.md](need.md).

## Verify everything: `npm run check`

```bash
npm run check             # one real call per integration
npm run check -- --send   # also posts a test message in the Discord channel
```

It uses the saved credentials (the default one of each type), else `.env`, and prints one line per integration:

| Result | Meaning |
|---|---|
| `OK` | The real service answered. |
| `FAIL` | The service refused: the reason and what to do are printed. The command exits with code 1. |
| `SKIP` | Not configured: the line says which `.env` variable or which credential to add. |

What each line does:

| Line | Real call |
|---|---|
| Email (SMTP) | Connects and signs in. With `CHECK_EMAIL_TO=you@example.com` in `.env` it also sends an email. |
| Forms | Starts a private copy of FlowForge on a free port, opens a form, submits a bad and a good answer. |
| Telegram | `getMe`. With a chat id (`TELEGRAM_CHAT_ID` or "Default Chat ID") it also sends a message. |
| Discord | Reads the webhook (posts nothing). With `--send` it posts a test embed. |
| Weather (Open-Meteo) | Looks up Paris and reads its current weather. |
| Google Gemini | Sends the prompt "Reply with the single word OK." |

Secrets are never printed. The same tests run when you click **Test** on the Credentials page.

---

## Email (SMTP)

Used by the **Send Email** node. You need an SMTP server: the two free options below take about 3 minutes.

### Option A: Gmail with an App Password (free)

Google does not accept your normal password from apps. You create a separate 16-letter **App Password**.

1. Turn on 2-Step Verification (required by Google for App Passwords):
   <https://myaccount.google.com/signinoptions/two-step-verification>
2. Open the App Passwords page: <https://myaccount.google.com/apppasswords>
3. Type a name (for example `FlowForge`) and click **Create**.
4. Copy the 16 letters shown (for example `abcd efgh ijkl mnop`). They are shown **only once**.
   The spaces do not matter: FlowForge removes them.

| Field | Value |
|---|---|
| Host | `smtp.gmail.com` |
| Port | `465` |
| SSL/TLS | **on** (or port `587` with SSL/TLS **off**) |
| User | your full Gmail address, e.g. `you@gmail.com` |
| Password | the 16-letter App Password |

Good to know:

- **Free limit:** about 500 recipients per day for a personal Gmail account (Google can change it).
- Gmail always sends **from your own address**. A different "From" is replaced by your address.
- **No "App passwords" page?** It is hidden when 2-Step Verification is off, when the account only uses
  security keys, with Advanced Protection, or on a **school / work account** whose administrator disabled
  it. Use a personal Gmail account, or Brevo below.
- Google help: <https://support.google.com/accounts/answer/185833>

### Option B: Brevo (free, 300 emails per day)

1. Create a free account: <https://www.brevo.com/>
2. Open **SMTP & API**: <https://app.brevo.com/settings/keys/smtp>
3. Note the **Login** shown on that page and click **Generate a new SMTP key**. Copy the key (shown once).
4. Add the address you want to send from under **Senders** and confirm it by email:
   <https://app.brevo.com/senders/list>

| Field | Value |
|---|---|
| Host | `smtp-relay.brevo.com` |
| Port | `587` |
| SSL/TLS | **off** (the connection is upgraded with STARTTLS) |
| User | the **Login** shown on the SMTP & API page |
| Password | the **SMTP key** (not your Brevo password, not the API key) |
| Default Sender (From) | the sender address you confirmed, e.g. `Shop <you@example.com>` |

### Where to paste it

**Credentials page (recommended)**

1. FlowForge → **Credentials** → **Add credential** → **SMTP**.
2. Click the **Gmail** or **Brevo** quick-setup button: host, port and SSL/TLS are filled in.
3. Fill in **User** and **Password** (and **Default Sender** for Brevo).
4. Click **Test**: you must see *Connected to … and signed in as …*.
5. Click **Save**. The first SMTP credential is the default: every Send Email node uses it automatically.

**Or the `.env` file** (copy `.env.example` to `.env` in the project folder, then restart FlowForge)

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=you@gmail.com
SMTP_PASS=abcdefghijklmnop
# Optional: sender used when the node's "From Email" is empty (default: SMTP_USER)
SMTP_FROM=FlowForge <you@gmail.com>
```

`SMTP_SECURE` can be left out: it is `true` for port 465 and `false` for any other port.

### How to verify

```bash
npm run check:email                       # sends a test email to yourself
npm run check:email -- friend@example.com # or to another address
npm run check:email -- --credential "Gmail account"   # a specific saved credential
```

It prints `OK` twice (connection + email sent), or `FAIL` with the reason:

| Message | What to do |
|---|---|
| `SMTP credentials are missing` | No credential saved and no `SMTP_HOST` in `.env`. |
| `SMTP authentication failed` | Wrong user or password. Gmail: use the App Password, not your normal password. |
| `Timed out while talking to the SMTP server` | Wrong host/port, or the network blocks SMTP (common on school Wi-Fi): try a phone hotspot. |
| `TLS problem` | Port 465 needs SSL/TLS **on**, port 587 needs it **off**. |
| `The server rejected the sender or a recipient` | Brevo: the From address is not a confirmed sender. |

The same check runs when you click **Test** on the Credentials page.

---

## Form

The **Form Trigger** needs **no key**. It publishes a web form and starts the workflow on each submission.

- **Test URL** `/form-test/…`: works for one submission after clicking **Listen for test event** (5 minutes).
- **Production URL** `/form/…`: works while the workflow is **Active**.
- The node shows a **QR code** of the URL (generated locally). Click it for a large version with
  **Copy** and **Download PNG**.

Opening the form on a **phone**: the phone must reach your computer.

1. Same Wi-Fi: scan the QR code. The URL uses your computer's network address (`http://192.168.x.x:5679/…`).
2. If the page does not load, the firewall of the computer blocks port 5679, or the Wi-Fi isolates devices
   (frequent on school networks). See **"Open FlowForge from a phone"** in the [README](README.md): firewall
   command for your system, or a Cloudflare tunnel that works on any network.

Optional settings in `.env`:

```ini
# Submissions per minute per visitor (anti-spam) and maximum upload size
FORM_RATE_LIMIT_PER_MINUTE=30
FORM_MAX_UPLOAD_MB=10
```

Spam protection is built in: an invisible "honeypot" field (bots fill it, their submission is dropped),
the rate limit above, and server-side validation of every field.

---

## Telegram

Used by the **Telegram** node (send, edit, delete, files, buttons) and the **Telegram Trigger** (messages and
commands sent to your bot). FlowForge reads updates by *long polling*: no public URL is needed, it works on
any network. Free.

### 1. Create the bot (2 minutes)

1. In Telegram, open **@BotFather**: <https://t.me/BotFather>
2. Send `/newbot`. Give a name (e.g. `FlowForge Demo`), then a username that ends in `bot`
   (e.g. `flowforge_demo_bot`).
3. BotFather answers with the **token**, e.g. `123456789:AAH…`. Copy it. (Later: `/mybots` → your bot →
   **API Token**.)
4. Open your new bot (the `t.me/your_bot` link in BotFather's answer) and press **Start**. A bot can only
   write to people who pressed Start.

### 2. Where to paste it

| Value | Credentials page (Add credential → **Telegram Bot**) | `.env` |
|---|---|---|
| Bot token (required) | **Bot Token** | `TELEGRAM_BOT_TOKEN=123456789:AAH…` |
| Your chat id (optional) | **Default Chat ID** | `TELEGRAM_CHAT_ID=123456789` |

Click **Test**: you must see *Connected as @your_bot*.

### 3. Find your chat id

The chat id is the number of the conversation between you and the bot.

1. In FlowForge create a workflow with a **Telegram Trigger** and click **Listen for test event**.
2. In Telegram send any message to your bot.
3. The trigger output shows `chatId` (also `message.chat.id`). Copy that number.

For a **group**: add the bot to the group, send a message that starts with `/` (bots do not see other group
messages by default), and read `chatId` the same way: it is a negative number such as `-1001234567890`.

In a workflow you rarely need it: answer in the chat that wrote to the bot with
`{{ $('Telegram Trigger').item.json.chatId }}`.

### Good to know

- **One reader per bot.** Only one program can read the updates of a bot. If the same bot is also used in
  n8n, in another FlowForge or in a script, the trigger shows *Another program is reading the updates of this
  bot*. Use a separate bot for FlowForge (`/newbot` again).
- When a Telegram Trigger starts, FlowForge **removes the webhook** of that bot (`deleteWebhook`), because a
  bot cannot have a webhook and long polling at the same time. An n8n workflow using that bot stops receiving.
- Commands: set **Only Command** to `/weather` in the trigger; `/weather Paris` gives `command: "weather"` and
  `args: "Paris"`.
- Messages sent while the workflow was inactive are handled when it is activated again (Telegram keeps them
  for at most 24 hours). The very first activation ignores old messages.
- Limits: text up to 4096 characters, captions 1024, files up to 50 MB (Bot API docs). Sending limits per
  second exist but I could not verify exact numbers: on a "too many requests" answer the node waits and retries.
- Docs: <https://core.telegram.org/bots/api> · BotFather: <https://core.telegram.org/bots/features#botfather>

---

## Discord

Used by the **Discord** node: messages and rich embeds in one channel, through a **webhook**. No bot, no
application to create. Free.

### 1. Create the webhook

You need the *Manage Webhooks* permission on the server (your own server always works).

1. In Discord, hover the channel → **Edit Channel** (gear) → **Integrations** → **Webhooks** → **New Webhook**.
2. Give it a name (and a picture), check the channel.
3. Click **Copy Webhook URL**. It looks like `https://discord.com/api/webhooks/1234567890/AbCd…`.

Anyone with this URL can post in the channel: treat it like a password.

### 2. Where to paste it

| Value | Credentials page (Add credential → **Discord Webhook**) | `.env` |
|---|---|---|
| Webhook URL | **Webhook URL** | `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…/…` |

Click **Test**: you must see *Webhook "name" is reachable*. The test reads the webhook and posts nothing.
To see a real message: `npm run check -- --send`.

### Good to know

- Limits (Discord docs): message text 2000 characters, 10 embeds per message, 6000 characters over all embeds,
  embed title 256, description 4096, 25 fields. The node checks them before sending and tells which one is
  exceeded. Option **Long Content → Truncate** cuts a long text instead of failing.
- Rate limits are decided by Discord per webhook (no fixed number in the docs). When Discord answers "too many
  requests" the node waits the time Discord asks for and retries (up to 3 tries).
- **Edit / delete**: keep the `id` returned by *Send Message* and use it as **Message ID**.
- One webhook posts to one channel. For another channel create another webhook and another credential.
- Docs: <https://docs.discord.com/developers/resources/webhook>

---

## Google Gemini

Used by the **Google Gemini** node (text, JSON answers, images, conversation memory).

### 1. Create the key

1. Open <https://aistudio.google.com/apikey> and sign in with a Google account.
2. Click **Create API key** (AI Studio creates or picks a Google Cloud project for you).
3. Copy the key.

### 2. Where to paste it

| Value | Credentials page (Add credential → **Google Gemini API**) | `.env` |
|---|---|---|
| API key (required) | **API Key** | `GEMINI_API_KEY=…` |
| Default model (optional) | **Default Model** | `GEMINI_MODEL=gemini-3.8-flash` |

Click **Test**: you must see *The key works (model gemini-3.8-flash answered)*.

### Good to know

- **Free tier:** Google's pricing page lists `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite` and
  `gemini-3.1-flash-lite` as free of charge on the free tier (checked 2026-10-12). The limits (requests per
  minute and per day) depend on your project and are **only shown in AI Studio**:
  <https://aistudio.google.com/rate-limit>. I could not verify numbers. Google lists the countries where the API is available at
  <https://ai.google.dev/gemini-api/docs/available-regions>. Check both pages with your account before the demo.
- "Gemini rate limit reached": the free limit of the minute or of the day is used up. The node already retries
  short waits. Wait, or choose `gemini-3.5-flash-lite` in the node.
- **Max Output Tokens**: leave it empty unless you need it. The model's thinking counts as output, so a small
  value can give an empty answer.
- Images: turn on **Send Images**; the binary file of the item is sent with the prompt (15 MB in total).
- **Conversation memory**: set *Conversation Memory → Remember the Conversation*; the session id of the Chat
  Trigger is used by default.
- On the free tier your prompts are used by Google to improve its products (pricing page: "Used to improve our
  products: Yes"): do not send private data.
- Docs: <https://ai.google.dev/gemini-api/docs/api-key> · models: <https://ai.google.dev/gemini-api/docs/models>

### AI Agent and AI Workflow Builder

Both use the same **Google Gemini API** credential (or `GEMINI_API_KEY`): nothing else to set up.

- **AI Agent**: the credential is chosen on its **Gemini Chat Model** sub-node. One message costs 1 to 8 Gemini
  requests (one per step of the agent), so the free limit is reached faster than with the plain Gemini node.
- **AI Workflow Builder** (prompt bar on the canvas): uses the default Gemini credential. Only the list of node
  types and your sentence are sent to Gemini: no key, no credential, no existing workflow. Without a key it still
  works, with ready-made templates ("Offline: closest template").
- Verify: import the example **Website chatbot with AI Agent**, click **Chat** and ask for the weather in a city.

---

## Weather (Open-Meteo)

Used by the **Weather (Open-Meteo)** node. **No key, no account, nothing to configure.**

- Type a city (`Paris`, `Paris, Texas`, `Casablanca, Morocco`) or coordinates.
- Free for non-commercial use: fewer than 10 000 calls per day, 5 000 per hour and 600 per minute
  (<https://open-meteo.com/en/terms>). The data is under CC BY 4.0: keep the *Weather data by Open-Meteo.com*
  line when you publish it (the node outputs it as `attribution`).
- Verify: `npm run check` prints the current weather of Paris.
- Docs: <https://open-meteo.com/en/docs>

---

## Chat

The **Chat Trigger** needs **no key**. It publishes a chat page; each message starts the workflow and the reply
is the output of the last node (its `output` or `text` field). To get an AI answer, connect a **Google
Gemini** node, which needs the [Gemini key](#google-gemini).

- **Test**: click the **Chat** button at the bottom right of the canvas and send a message. The workflow
  runs live on the canvas.
- **Production**: switch the workflow to **Active**. The node shows the chat URL (`/chat/…`) with a QR code
  for phones. See [Form](#form) if the phone cannot open it.

---

## Webhook authentication

The **Webhook** node can require a login. Choose **Basic Auth** or **Header Auth** in the node, then pick or
create the credential right there (**Credential to connect with → Create new credential…**).

| Credential | Fields | Caller must send |
|---|---|---|
| Basic Auth | User, Password | `curl -u user:password http://…/webhook/path` |
| Header Auth | Header Name (e.g. `X-API-Key`), Header Value | `curl -H "X-API-Key: value" http://…/webhook/path` |

Without the credential the workflow cannot be activated ("Basic Auth credentials are missing").

---

## HTTP Request authentication

The **HTTP Request** and **GraphQL** nodes can sign in to any API. Choose the kind of login in
**Authentication**, then pick or create the credential right in the node. The secret is stored encrypted and
is never written into the workflow, the execution data or an error message.

| Authentication | Credential | Fields | What is sent |
|---|---|---|---|
| Basic Auth | Basic Auth | User, Password | `Authorization: Basic …` |
| Bearer Token | Bearer Auth | Bearer Token (without the word "Bearer") | `Authorization: Bearer <token>` |
| API Key in a Header | Header Auth | Header Name (e.g. `X-API-Key`), Header Value | `<name>: <value>` |
| API Key in the URL | Query Auth | Parameter Name (e.g. `api_key`), Value | `?<name>=<value>` |

Tips:

- **Import cURL**: paste a command from API docs. A token or `-u user:password` found in it is saved as a
  credential (untick the box in the dialog to keep it as a plain header instead).
- A `401` answer with a credential shows **Open Credentials** in the error, to fix the value on the spot.
- No key at hand? These public APIs need none: `https://api.github.com/repos/n8n-io/n8n` (JSON),
  `https://countries.trevorblades.com/` (GraphQL).

---

## Troubleshooting

Run `npm run check` first: it names the integration that fails and why.

| Message or symptom | Cause | Fix |
|---|---|---|
| `… credentials are missing` with an **Open Credentials** button | No credential saved and the `.env` variable is empty | Add the credential, or fill the variable named in the message and restart FlowForge |
| `Telegram rejected the bot token` | Wrong or revoked token | Copy it again from @BotFather (`/mybots` → API Token) |
| `Another program is reading the updates of this bot` | The bot is also used in n8n, another FlowForge or a script | Stop the other program, or create a second bot with `/newbot` |
| `Telegram refused the request: Bad Request: chat not found` | Wrong chat id, or the person never pressed **Start** | Press Start in the bot, check the chat id ([how to find it](#3-find-your-chat-id)) |
| `can't parse entities` (Telegram) | The text has `<`, `_`, `*`… that Parse Mode does not accept | Set **Parse Mode** to None, or escape the text |
| The Telegram Trigger never fires in a group | Bots only see commands in groups by default | Send a message that starts with `/`, or change the privacy mode in @BotFather (`/setprivacy`) |
| `Discord does not accept this webhook` | The webhook was deleted or the URL is cut | Copy the webhook URL again in Discord and update the credential |
| `The message is … characters long; Discord allows 2000` | Text too long | Shorten it, or set **Long Content → Truncate** |
| `The Gemini API key is not valid` | Wrong key | Create a new key at <https://aistudio.google.com/apikey> |
| `Gemini rate limit reached` | Free limit of the minute or the day is used up | Wait, or choose `gemini-3.5-flash-lite`; see your limits in AI Studio |
| `The model "…" does not exist` | Typo in the model, or the model was retired | Choose a model from the list of the node; update `GEMINI_MODEL` |
| `No Chat Model is connected to the AI Agent` | The agent has no model | Click **+** under the agent's *Chat Model* slot and add a Gemini Chat Model |
| `The agent did not reach an answer in 8 steps` | The model kept calling tools | Make the System Message more precise, remove a confusing tool |
| The builder says **Offline: closest template** | No Gemini key, the free limit is reached, or Gemini's answer was not a valid workflow (the reason is shown) | Add the key or wait; the template is a working starting point |
| `No place found for "…"` (Weather) | Unknown or misspelled city | Add the country (`Paris, France`) or use coordinates |
| `The server "…" could not be found` / `Could not connect … in time` | No internet, or the network blocks the service | Check the connection; school Wi-Fi may block Telegram or SMTP: try a phone hotspot |
| `SMTP authentication failed` | Gmail needs an App Password | See [Email](#email-smtp) |
| The phone cannot open a form or chat | Firewall, or Wi-Fi isolation | README → "Open FlowForge from a phone" |
| `This chat is not available` | The workflow is not active | Switch it to **Active** |
| `This credential cannot be decrypted` | `data/.encryption_key` changed | Type the credential values again |

