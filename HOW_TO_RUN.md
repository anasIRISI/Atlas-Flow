# How to run Atlas Flow

Step-by-step guide for a new teammate: from zero to a running FlowForge, then the optional keys, the tests and
the most common problems. Everything here is free. Expected time: **5 minutes** without keys, **20 minutes** with
all the keys.

---

## 1. Install the tools (once)

| Tool | Version | Check | Get it |
|---|---|---|---|
| **Node.js** | **20.11 or newer** (22 LTS recommended) | `node -v` | <https://nodejs.org> (LTS installer) or `nvm install 22` |
| **npm** | comes with Node | `npm -v` | — |
| **git** | any | `git --version` | <https://git-scm.com> |
| Google Chrome | only for the browser tests | — | <https://www.google.com/chrome> |

Windows: use **PowerShell** or **Git Bash**. macOS / Linux: any terminal. Nothing else is needed: the database
(SQLite) is embedded, there is no Docker, no Python, no external service to install.

## 2. Get the code

```bash
git clone https://github.com/anasIRISI/Atlas-Flow.git
cd Atlas-Flow
```

(Private repository: ask the owner to add your GitHub account as a collaborator first.)

## 3. Install the dependencies

```bash
npm install
```

- Takes 10 seconds to 3 minutes depending on the network.
- It downloads a prebuilt SQLite driver (`better-sqlite3`). If that download fails on a filtered network, FlowForge
  still works on **Node 22.13+** (it falls back to Node's built-in SQLite). On Node 20, run `npm install` again on
  a better network.

## 4. Start it

```bash
npm start
```

- The **first** start builds the app (about 15-40 seconds). Later starts are instant unless the code changed.
- When you see this, it is ready:

  ```
    FlowForge v0.1.0 is running

    ➜ Local:    http://localhost:5679
    ➜ Network:  http://192.168.x.x:5679
  ```

- Open **<http://localhost:5679>**.
- First visit: the **Set up owner account** screen. Enter an email, a name and a password (8+ characters, at least
  1 number and 1 capital letter). This account is local to your computer.
- Stop the app with **Ctrl+C** in the terminal.

Port 5679 is used so FlowForge can run next to real n8n (5678). To use another port, see step 6.

## 5. Try it in 2 minutes (no key needed)

1. **Overview** → **Demo Mode**: a guided tour builds a workflow, shows a form QR code, simulates a submission
   after 20 seconds and runs it live. Without keys the email / Telegram / Discord steps show an orange
   **SIMULATED** badge (only Demo Mode ever simulates).
2. **Templates** → **CSV pipeline** → **Use template** → **Execute workflow**: watch the data flow node by node.
3. **Executions** → open a run → **Time travel**: replay it step by step.
4. **Workflows** → **Create workflow**: describe an automation in the AI bar at the top, or click **Add first step**.

## 6. Configuration and keys (optional)

FlowForge starts without any configuration. To change settings or connect real services, create a `.env` file:

```bash
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
```

Fill in only what you need, then restart (`Ctrl+C`, `npm start`). **Never commit `.env`** (it is already in
`.gitignore`). Instead of `.env`, every key can also be saved (encrypted) on the **Credentials** page, which has a
**Test** button.

| Service | `.env` variables | Where to get it | Powers |
|---|---|---|---|
| Gmail (SMTP) | `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER=you@gmail.com`, `SMTP_PASS=<16-letter App Password>` | 2-Step Verification on, then <https://myaccount.google.com/apppasswords> | Send Email, form → email examples |
| Telegram | `TELEGRAM_BOT_TOKEN`, optional `TELEGRAM_CHAT_ID` | Telegram → **@BotFather** → `/newbot`, then press **Start** in your bot | Telegram nodes and trigger |
| Discord | `DISCORD_WEBHOOK_URL` | Channel → **Edit Channel → Integrations → Webhooks → New Webhook → Copy URL** (not an invite link) | Discord node |
| Google Gemini | `GEMINI_API_KEY`, optional `GEMINI_MODEL` | <https://aistudio.google.com/apikey> | AI Workflow Builder, AI Agent, chatbots |
| Weather (Open-Meteo) | nothing | — | Weather node and tool |
| Test email recipient | `CHECK_EMAIL_TO` | any address you read | `npm run check` |

Other useful settings (all documented in `.env.example`): `PORT` (default 5679), `PUBLIC_URL` (address used in
QR codes and form links; default = your LAN address), `GENERIC_TIMEZONE`, `EXECUTION_TIMEOUT_SECONDS`.

Detailed, click-by-click guides: [API_SETUP.md](API_SETUP.md) and the checklist [need.md](need.md).

**Check your keys** from the terminal:

```bash
npm run check            # one real call per service: OK / FAIL (with the reason) / SKIP (what to set where)
                         # (also sends a Telegram test message when TELEGRAM_CHAT_ID is set)
npm run check -- --send  # also posts a test message in the Discord channel
npm run check:email      # sends a real test email
```

A node whose key is missing never crashes: it shows a clear error with an **Open Credentials** button.

## 7. Development mode (hot reload)

```bash
npm run dev
```

Open **<http://localhost:5173>** (Vite dev server; it forwards API calls to the server on 5679). Server and UI
reload when you save a file.

Project layout (npm workspaces):

```
shared/   types and pure helpers used by both sides (forms, timeline, version diff)
server/   Express API, WebSocket, workflow engine, nodes (server/src/nodes/<group>/<name>.node.ts), SQLite
web/      React UI (editor in web/src/editor, pages in web/src/pages)
examples/ importable example workflows      templates/  extra templates for the gallery
docs/     design notes per phase             data/       your local database and files (created at first start, never committed)
```

Adding a node = adding one file in `server/src/nodes/<group>/`: it is loaded automatically and its form is generated
from its description.

## 8. Run the tests

```bash
npm test                              # type checks + ~930 unit / API tests, offline, about 1-2 minutes
PW_CHANNEL=chrome npm run test:e2e    # 47 browser tests with your installed Chrome (about 3 minutes)
```

Without Chrome: `npx playwright install chromium` once, then `npm run test:e2e`. The browser tests start their own
server on port 5699 with a throw-away database, so they never touch your data.

## 9. Open it from a phone

Forms, chat pages and QR codes use the **Network** address printed at startup.

1. Phone on the **same Wi-Fi** as the computer.
2. Open port 5679 in the computer's firewall:
   - Fedora: `sudo firewall-cmd --add-port=5679/tcp`
   - Ubuntu: `sudo ufw allow 5679/tcp`
   - Windows (admin PowerShell): `netsh advfirewall firewall add rule name="FlowForge" dir=in action=allow protocol=TCP localport=5679`
   - macOS: click **Allow** when asked.
3. Wi-Fi that isolates devices (school, guest networks): use a Cloudflare quick tunnel,
   `cloudflared tunnel --url http://localhost:5679`, put the printed `https://….trycloudflare.com` address in
   `PUBLIC_URL` in `.env`, restart.

## 10. Common problems

| Problem | Fix |
|---|---|
| `node: command not found` or "requires Node 20.11" | Install Node 22 LTS, open a new terminal |
| Port 5679 already in use | Another FlowForge is running (stop it), or set `PORT=5680` in `.env` |
| "No SQLite driver could be loaded" | `npm install` again on a better network, or use Node 22.13+ |
| Forgot the owner password | `npm run user:reset` (deletes the account only; workflows are kept), then set up again |
| "This credential cannot be decrypted" | `data/.encryption_key` changed: open the credential and type the values again |
| A node says "… credentials are missing" | Add the key on **Credentials** (or in `.env`, then restart) |
| Gmail: authentication failed | Use the 16-letter **App Password**, not your normal password |
| Discord: "does not accept this webhook" | You pasted an invite link (`discord.gg/…`): copy the **webhook** URL instead |
| Gemini: "No answer within 45 s" | Slow internet to Google: retry, or use a faster network / phone hotspot. The AI builder falls back to an offline template |
| Telegram: "Another program is reading the updates of this bot" | Stop n8n or any other program using the same bot |
| Phone cannot open the form | Same Wi-Fi? Firewall open (step 9)? Otherwise use the Cloudflare tunnel |
| Want a clean start | Stop the app and delete the `data/` folder (this deletes your local workflows and account) |

More: [README.md](README.md) (features, architecture, teacher demo script), [FEATURES.md](FEATURES.md) (what is
implemented and tested).
