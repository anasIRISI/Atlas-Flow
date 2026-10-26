# need.md: everything you must provide for FlowForge to work 100%

Tick each box when it is done. Nothing here costs money.
**Never write a real key in this file or in git.** Keys go in `.env` (ignored by git) or on the Credentials page.

Status of this file: final version (Phase 8). It lists only what the app really uses.
Items marked **(not verified)** could not be tested by the developer without real keys: you test them with
`npm run check`.

---

## 1. Quick summary

| Item | Required? | Free? | Where to get it | Where to put it | What breaks without it |
|---|---|---|---|---|---|
| Node.js 20.11+ and npm | **Required** | Yes | <https://nodejs.org> | Installed on the computer | Nothing starts |
| Owner account | **Required** | Yes | Created on the first screen | Stored in `data/` | You cannot sign in |
| Email: Gmail App Password (or Brevo SMTP key) | Optional | Yes | <https://myaccount.google.com/apppasswords> | Credential **SMTP**, or `SMTP_*` in `.env` | **Send Email** node fails with "SMTP credentials are missing" |
| Telegram bot token | Optional | Yes | @BotFather in Telegram | Credential **Telegram Bot**, or `TELEGRAM_BOT_TOKEN` | **Telegram** and **Telegram Trigger** nodes fail |
| Telegram chat id | Optional | Yes | Read it in the Telegram Trigger | **Default Chat ID**, or `TELEGRAM_CHAT_ID` | Telegram nodes with an empty Chat ID fail; `npm run check` skips the test message |
| Discord webhook URL | Optional | Yes | Discord channel → Integrations → Webhooks | Credential **Discord Webhook**, or `DISCORD_WEBHOOK_URL` | **Discord** node fails |
| Gemini API key | Optional | Yes (free tier) | <https://aistudio.google.com/apikey> | Credential **Google Gemini API**, or `GEMINI_API_KEY` | **Google Gemini** node and the chatbot example fail |
| Open-Meteo (weather) | Nothing to provide | Yes | No key | Nowhere | Works out of the box (needs internet) |
| Forms, Chat page, Webhooks | Nothing to provide | Yes | No key | Nowhere | Work out of the box |
| Phone on the same Wi-Fi, port 5679 open | Optional | Yes | Section 3 | Firewall of the computer | The phone cannot open forms, chats and QR codes |
| Internet connection | Needed for the 5 online services | | | | Email, Telegram, Discord, Gemini and weather fail with a clear network error |

"Optional" means FlowForge starts and every other node works without it. A node that needs a missing key
shows a clear error with an **Open Credentials** button: it never crashes and never fakes a result.
The only exception is **Demo Mode** (section 2d): there, a node without a key returns made-up output with an
orange **SIMULATED** badge, so the guided tour never stops. Outside Demo Mode this never happens.

---

## 2. Accounts and keys, one by one

Two places accept every key. Pick one per key:

- **Credentials page** (recommended): FlowForge → **Credentials** → **Add credential**. Encrypted, has a
  **Test** button.
- **`.env` file** in the project folder (copy `.env.example` to `.env`). Restart FlowForge after editing it.

A saved credential wins over `.env`.

### 2.1 Email: Gmail App Password

- [ ] Turn on 2-Step Verification: <https://myaccount.google.com/signinoptions/two-step-verification>
- [ ] Open <https://myaccount.google.com/apppasswords>, name it `FlowForge`, click **Create**
- [ ] Copy the 16 letters (shown once; spaces do not matter)
- [ ] Put it in FlowForge:

| Credentials page: **SMTP** → click **Gmail** | `.env` |
|---|---|
| **Host** `smtp.gmail.com` | `SMTP_HOST=smtp.gmail.com` |
| **Port** `465` | `SMTP_PORT=465` |
| **SSL/TLS** on | `SMTP_SECURE=true` |
| **User** your Gmail address | `SMTP_USER=you@gmail.com` |
| **Password** the 16 letters | `SMTP_PASS=abcdefghijklmnop` |

- [ ] Verify: `npm run check:email` (prints `OK` twice and an email arrives) **(not verified by the developer with real Gmail)**

No "App passwords" page? It is hidden on school / work accounts and when 2-Step Verification is off.
Use a personal Gmail account, or Brevo:

**Alternative: Brevo** (free plan, 300 emails per day according to third-party guides, not verified)

- [ ] Create an account at <https://www.brevo.com/>, open <https://app.brevo.com/settings/keys/smtp>
- [ ] Note the **Login**, click **Generate a new SMTP key**, copy the key
- [ ] Confirm a sender address at <https://app.brevo.com/senders/list>
- [ ] Credential **SMTP** → click **Brevo**: **User** = the Login, **Password** = the SMTP key,
      **Default Sender (From)** = the confirmed address.
      Or `.env`: `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- [ ] Verify: `npm run check:email`

### 2.2 Telegram: bot token and chat id

- [ ] In Telegram open <https://t.me/BotFather> and send `/newbot`
- [ ] Choose a name, then a username ending in `bot` (e.g. `flowforge_demo_bot`)
- [ ] Copy the token BotFather gives (looks like `123456789:AAH…`)
- [ ] Open your bot and press **Start**
- [ ] Put the token in FlowForge:

| Credentials page: **Telegram Bot** | `.env` |
|---|---|
| **Bot Token** | `TELEGRAM_BOT_TOKEN=123456789:AAH…` |
| **Default Chat ID** (optional) | `TELEGRAM_CHAT_ID=123456789` |

- [ ] Find your chat id: new workflow → **Telegram Trigger** → **Listen for test event** → send a message to
      the bot → copy `chatId` from the output → put it in **Default Chat ID** (or `TELEGRAM_CHAT_ID`)
- [ ] Verify: `npm run check` (line `Telegram` = OK, line `Telegram: test message` = a message arrives on
      your phone) **(not verified by the developer with a real bot)**

Important: use this bot **only in FlowForge**. If n8n or another program reads the same bot, one of them
stops receiving. For the side-by-side comparison with n8n, create a second bot.

### 2.3 Discord: webhook URL

- [ ] In Discord: your server → hover a channel → **Edit Channel** → **Integrations** → **Webhooks** → **New Webhook**
- [ ] Click **Copy Webhook URL** (looks like `https://discord.com/api/webhooks/1234567890/AbCd…`)
- [ ] Put it in FlowForge:

| Credentials page: **Discord Webhook** | `.env` |
|---|---|
| **Webhook URL** | `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…/…` |

- [ ] Verify: `npm run check -- --send` (line `Discord` = OK and a green "FlowForge check" card appears in
      the channel) **(not verified by the developer with a real server)**

### 2.4 Gemini: API key

- [ ] Open <https://aistudio.google.com/apikey>, sign in, click **Create API key**
- [ ] Copy the key
- [ ] Put it in FlowForge:

| Credentials page: **Google Gemini API** | `.env` |
|---|---|
| **API Key** | `GEMINI_API_KEY=…` |
| **Default Model** (optional, default `gemini-3.8-flash`) | `GEMINI_MODEL=gemini-3.8-flash` |

- [ ] Verify: `npm run check` (line `Google Gemini` = OK) **(not verified by the developer with a real key)**
- [ ] Look at your free limits: <https://aistudio.google.com/rate-limit> **(numbers not verified: they depend on your account)**

### 2.5 Open-Meteo (weather)

- [ ] Nothing to do: no account, no key
- [ ] Verify: `npm run check` (line `Weather (Open-Meteo)` = OK, with the weather of Paris). Verified by the
      developer with the real service.

---

## 2b. AI features: what needs the Gemini key, what works offline

| Feature | Without a Gemini key | With the Gemini key |
|---|---|---|
| **AI Workflow Builder** (prompt bar on the canvas: "Describe your automation…") | Works **offline**: it picks the closest ready-made template and labels the result **"Offline: closest template"**. The 6 suggestion chips all have a matching template | Gemini writes a workflow for your sentence, labelled **"Built with Gemini"**. If Gemini fails (rate limit, timeout, invalid answer) the offline template is used and the reason is shown |
| **AI Agent** node (with Gemini Chat Model, Simple Memory, tools) | Does not run: the *Gemini Chat Model* shows "Google Gemini API credentials are missing" with **Open Credentials** | Works |
| Tools of the agent: **Calculator**, **Code Tool** | Run locally, no internet, but only an agent can call them | Work |
| Tools of the agent: **Weather Tool**, **HTTP Request Tool** | Same; they also need internet (the Weather Tool needs no key) | Work |
| **Google Gemini** node, chatbot examples | Clear "credentials are missing" error | Work |
| Everything else (editor, triggers, forms, chat page, data nodes, email, Telegram, Discord) | Unaffected | Unaffected |

- [ ] Gemini key added (section 2.4): it is the **only** key the AI features need
- [ ] The builder never sends a key, a credential or your existing workflow to Gemini: only the list of node
      types and the sentence you typed
- [ ] An agent stops by itself after at most 8 model calls per message
- [ ] Each chat message of an agent costs 1 to 8 Gemini requests (one per step): watch the free limit in AI
      Studio while rehearsing **(limits not verified)**
- [ ] Verify with the key: import the example "Website chatbot with AI Agent", click **Chat**, ask
      *What is the weather in Paris?* **(not verified by the developer with a real key)**

---

## 2c. Variables, settings and data retention (no key needed)

These are set in the app, not in `.env`. Nothing here is required: the defaults work.

**Variables** (sidebar → **Variables**)
- A variable is a name and a text value that every workflow can read, for example `city` = `Paris`.
- Use it in any field in expression mode: `{{ $vars.city }}`, and in the Code node: `$vars.city`.
- Change the value once and every workflow uses the new value at its next run.
- Variables are **not secret** (like in n8n): never put a password or an API key in one. Keys belong on the
  **Credentials** page.

**Settings** (sidebar → **Settings**). Each field shows the value in effect; "default" means the `.env` value.
| Setting | What it means in simple words | Default |
|---|---|---|
| Time zone | The clock used by `$now`, dates and Schedule triggers. Active workflows restart their schedules when you change it | `GENERIC_TIMEZONE` of `.env` |
| Execution timeout | A run that takes longer is stopped. A workflow can set its own value (workflow settings) | 300 s |
| Concurrency | How many runs can work at the same time; the others wait their turn | 5 |
| Save data of successful / failed / manual runs | "Save" keeps the run in **Executions** so you can look inside it; "Don't save" deletes it right after it ends (manual runs: after 10 minutes, so the editor can still show the result) | Save |
| Allow `$env` | Lets expressions read environment variables. Anything that looks like a password or key is always hidden | `.env` value |
| Execute Command node | Lets workflows run shell commands on this computer. Keep it **off** unless you need it | Off |

**Data retention** (Settings → Data retention)
- FlowForge deletes old runs automatically so the database stays small: runs older than **N days** (default 14)
  and anything beyond the newest **N runs** (default 10 000). `0` = never delete.
- Runs that are still **running or waiting** (for example a Wait node or a form step) are **never** deleted.
- **Prune now** applies the rules immediately. The check also runs at startup and every 10 minutes.

- [ ] Before the demo: decide whether you want old test runs in **Executions** (they make the dashboard look
      busy) or click **Prune now** with a small number of days

---

## 2d. Demo Mode and the time-travel debugger (no key needed)

**Demo Mode** (sidebar → **Demo Mode**, or the button on **Overview**) is a guided 5-step tour:
1. the AI builder creates a "form → weather → email + Telegram + Discord" workflow (without a Gemini key or
   internet it uses the built-in showcase workflow, labelled as such),
2. it shows the form's QR code: scan it with your phone and submit,
3. if nobody submits within 20 seconds it sends a sample submission itself ("Simulating a submission"),
4. the run plays live on the canvas,
5. a results card lists each service: sent / **simulated (no key)** / failed (with the reason).

**Skip step** jumps ahead, **Stop demo** leaves at any time. What makes it better, all optional:

| You provide | Effect in Demo Mode |
|---|---|
| Nothing | Works: showcase workflow, simulated submission, email / Telegram / Discord marked SIMULATED |
| Gemini key | Step 1 is really built by Gemini |
| SMTP, Telegram, Discord keys | Those steps really send (the email goes to the address typed in the form) |
| Internet | The weather is real (Open-Meteo); without internet the weather step shows as failed, the tour continues |
| Phone on the same Wi-Fi | You can submit the form yourself from the QR code |

Demo workflows are saved with the tag `demo`: delete them from **Workflows** after rehearsing.

**Time travel**: **Executions** → open a run → **Time travel**. A scrubber at the bottom of the editor replays the run
step by step (←/→, Space to play, Esc to leave) and shows each step's input, output and duration; **Re-run from
here** starts a new run from that node with the earlier results. Nothing to provide; it never changes the stored run.

---

## 3. Machine requirements

- [ ] **Node.js 20.11 or newer** (22 LTS recommended). Check: `node -v`
- [ ] **npm** (comes with Node). Check: `npm -v`
- [ ] **Internet** during `npm install`, and for the online services
- [ ] **Port 5679 is free.** Otherwise set `PORT=5680` in `.env`
- [ ] **Google Chrome** only if you want to run the browser tests (`PW_CHANNEL=chrome npm run test:e2e`)

For the phone (forms, chat page, QR codes):

- [ ] Phone and computer on the **same Wi-Fi**
- [ ] Open the port in the firewall. Fedora:
      `sudo firewall-cmd --add-port=5679/tcp` (until reboot). To keep it:
      `sudo firewall-cmd --permanent --add-port=5679/tcp && sudo firewall-cmd --reload` **(not verified)**
- [ ] Find the address of the computer: `hostname -I` (first address, e.g. `192.168.1.20`).
      FlowForge prints it at startup: `➜ Network: http://192.168.1.20:5679`
- [ ] Only if the printed address is wrong: set `PUBLIC_URL=http://192.168.1.20:5679` in `.env` and restart
- [ ] Optional, when the Wi-Fi blocks devices from seeing each other (common at school): Cloudflare tunnel.
      Install `cloudflared` (<https://github.com/cloudflare/cloudflared/releases>), run
      `cloudflared tunnel --url http://localhost:5679`, put the printed `https://….trycloudflare.com` address
      in `PUBLIC_URL`, restart FlowForge **(not verified)**

---

## 4. First run

From a clean clone:

```bash
npm install     # 1 to 3 minutes
npm start       # the first start builds the app (15 to 30 seconds)
```

- [ ] The terminal shows `➜ Local: http://localhost:5679` and `➜ Network: http://192.168.x.x:5679`
- [ ] Open <http://localhost:5679>
- [ ] First screen: **"Set up owner account"**. Fill in Email, First name, Last name and a Password
      (8+ characters, at least 1 number and 1 capital letter), then confirm
- [ ] You arrive in the dark FlowForge interface (left menu: Overview, Workflows, Credentials, Settings…)
- [ ] Optional: `cp .env.example .env`, fill in the keys of section 2, then stop (Ctrl+C) and `npm start` again
- [ ] Run `npm run check`

Forgot the password? `npm run user:reset` deletes the account (workflows are kept), then create it again.

---

## 5. Ready `.env` template

Copy this to a file named `.env` in the project folder. Every line is optional. Lines starting with `#` are
comments. **Replace the examples with your own values; never commit this file.**

```ini
# ── Server ──────────────────────────────────────────────────────────────
# Port of FlowForge. Optional (default 5679).
PORT=5679
# Address used in QR codes, form and chat URLs. Optional: empty = detected automatically.
# Format: http://192.168.1.20:5679  or  https://your-words.trycloudflare.com
PUBLIC_URL=

# ── Email (needed for the Send Email node unless an SMTP credential is saved) ──
# Gmail: smtp.gmail.com / 465 / true.   Brevo: smtp-relay.brevo.com / 587 / false.
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
# Your full address. Format: you@gmail.com
SMTP_USER=
# Gmail: the 16-letter App Password (NOT your normal password). Brevo: the SMTP key.
SMTP_PASS=
# Optional sender name. Format: FlowForge <you@gmail.com>
SMTP_FROM=
# Optional: `npm run check` also sends a real email to this address.
CHECK_EMAIL_TO=

# ── Telegram (needed for the Telegram nodes unless a Telegram Bot credential is saved) ──
# Token from @BotFather. Format: 123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_BOT_TOKEN=
# Optional: your chat id (a number). Format: 123456789   (groups: -1001234567890)
TELEGRAM_CHAT_ID=

# ── Discord (needed for the Discord node unless a Discord Webhook credential is saved) ──
# Format: https://discord.com/api/webhooks/123456789012345678/xxxxxxxxxxxxxxxx
DISCORD_WEBHOOK_URL=

# ── Google Gemini (needed for the Google Gemini node unless a credential is saved) ──
# Key from https://aistudio.google.com/apikey
GEMINI_API_KEY=
# Optional (default gemini-3.8-flash). Other free-tier models: gemini-3.6-flash, gemini-3.5-flash-lite
GEMINI_MODEL=

# ── Weather (Open-Meteo): nothing to set ──
```

The full list of settings (timeouts, limits, data folder, encryption key) is in `.env.example`.

---

## 6. Before the teacher demo

The day before:

- [ ] `npm run check -- --send` shows **no FAIL** and no SKIP for the services you will show
- [ ] `npm test` is green
- [ ] Import the examples: **Workflows → Examples** → import all eleven (the resilience demo imports 3 linked workflows)
- [ ] Open each imported workflow, read its note, set your own email address / city
- [ ] **Form**: activate "Contact form → Discord embed + confirmation email", scan the QR code with your
      phone, submit, check the Discord card and the email
- [ ] **Telegram**: activate "Telegram assistant: /weather", send `/weather Paris` from your phone, get the answer
- [ ] **Chat**: open "Website chatbot (Gemini)", click **Chat**, ask two questions (the second one should
      show that the bot remembers); activate it and open the chat page from your phone
- [ ] **Weather email**: open "Daily weather → HTML email", click **Execute workflow**, check the inbox
- [ ] Check your Gemini limits in AI Studio (do not burn the daily free quota while rehearsing)
- [ ] Run **Demo Mode** twice: once without touching the phone (simulated submission), once submitting from the QR code
- [ ] Open one finished run in **Time travel** and step through it
- [ ] Rehearse the whole demo once with a timer (README → "Teacher demo script")

On the day, in the room:

- [ ] Start FlowForge (`npm start`) and read the `Network` address: the Wi-Fi of the room gives a new address
- [ ] Test the QR code from your phone on the room's Wi-Fi. If it fails: phone hotspot for the computer, or the
      Cloudflare tunnel (section 3)
- [ ] `npm run check` once more (the school network may block email or Telegram)
- [ ] Close n8n workflows that use the same Telegram bot
- [ ] Keep the charger plugged in and disable sleep

10 minutes before:

- [ ] `npm start`, sign in, open **Overview** on the projector (check the Public URL card shows the room's address)
- [ ] `npm run check` (no FAIL for the services you will show)
- [ ] Scan one QR code with the phone on the room's Wi-Fi
- [ ] Delete old `demo`-tagged workflows (Workflows → tag chip **demo** → select → delete) so the list looks clean
- [ ] Phone volume off, notifications off; Telegram open on the bot chat

Right after the demo:

- [ ] **Revoke the keys** you used: Gmail App Password (myaccount.google.com/apppasswords → delete), Telegram
      (@BotFather → `/revoke`), Discord (channel → Integrations → Webhooks → delete), Gemini (aistudio.google.com/apikey
      → delete). Then delete the matching credentials and empty the values in `.env`

Backup plan:

- [ ] **Screen recording** of the full demo made the day before (form on the phone, Discord, Telegram, chat)
- [ ] **Phone hotspot** ready in case the room's Wi-Fi blocks services
- [ ] **Offline part of the demo**: the editor, Manual Trigger, Code, IF/Switch/Merge, data nodes, Form and
      Chat Trigger with a Code node as reply, Webhook with `curl`, Schedule: none of these need internet
- [ ] If one service is down: its node shows a clear error (not a crash); show the error handling
      (Retry On Fail, Continue On Error, error output) as a feature
- [ ] A copy of your `.env` in a safe place (not in git)

---

## 7. Troubleshooting: the 10 most likely problems

| # | Problem | Fix |
|---|---|---|
| 1 | `… credentials are missing` on a node | Click **Open Credentials** and add it, or fill the `.env` variable named in the error and restart |
| 2 | Gmail: `SMTP authentication failed` | Use the 16-letter **App Password**, not your normal password; 2-Step Verification must be on |
| 3 | Emails do not leave on the school Wi-Fi (`Timed out while talking to the SMTP server`) | The network blocks SMTP: use a phone hotspot |
| 4 | The phone cannot open the form / chat / QR link | Same Wi-Fi? Open port 5679 (section 3). Still no: Cloudflare tunnel + `PUBLIC_URL` |
| 5 | Telegram: `Another program is reading the updates of this bot` | Stop n8n or the other program using this bot, or create a second bot |
| 6 | Telegram: `chat not found` | Press **Start** in your bot; check the chat id |
| 7 | Telegram Trigger does nothing | The workflow must be **Active** (or "Listen for test event" running); in groups only `/commands` are seen |
| 8 | Discord: `Discord does not accept this webhook` | The webhook was deleted or the URL is incomplete: copy it again |
| 9 | Gemini: `The Gemini API key is not valid` or `rate limit reached` | New key at aistudio.google.com/apikey; for the limit wait a minute or choose `gemini-3.5-flash-lite` |
| 10 | `npm start` fails: port in use, or "No SQLite driver could be loaded" | `PORT=5680` in `.env`; for SQLite run `npm install` again on a good network or use Node 22.13+ |

More cases: the troubleshooting table at the end of [API_SETUP.md](API_SETUP.md#troubleshooting) and the
README.
