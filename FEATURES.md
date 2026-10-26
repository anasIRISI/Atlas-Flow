# FlowForge — Feature checklist

**Rules**
- `[x]` = implemented **and** covered by an automated test **and** checked manually. The proof is written
  after the item (`test:` file, `e2e:` spec, `manual:` what was checked).
- `[ ]` = not done yet. Nothing is ticked on intent.
- Priority: **P0** must work (never cut) · **P1** important (AI, time travel, Demo Mode, versions) ·
  **P2** everything else (cut first if time is short).
- `(Ph N)` = phase in which the item is planned.

---

## Foundation
- [x] P0 `npm install` then `npm start` runs backend + built frontend on port 5679 (Ph 0) — e2e: `web/e2e/phase0-auth-shell.spec.ts` (runs the built app); manual: fresh install, first start builds in 12 s, second start skips the build, clear messages for busy port / invalid `.env`
- [x] P0 `npm run dev` with hot reload (Ph 0) — manual: Vite on :5173 proxies `/api`, `/webhook`, `/ws`; SPA deep links; server restarts on file change
- [x] P0 `npm test` (typecheck + unit/API tests, offline) (Ph 0) — 48 tests at Ph 0; Ph 8: 930 tests (shared 31, server 833, web 66) + 47 Playwright tests
- [x] P0 SQLite driver: better-sqlite3 12.9.0 (prebuilt binaries for Node 20/22/24) with automatic fallback to built-in `node:sqlite` on Node ≥ 22.13 (Ph 0) — test: `server/tests/driver.test.ts`; full server suite passes on Node 20.18 (better-sqlite3) and Node 22.22 (fallback). Not yet tried on Node 24/26.
- [x] P0 SQLite database with ordered migrations, created automatically in `./data` (Ph 0) — test: `server/tests/db.test.ts` (idempotent, failed migration rolls back fully)
- [x] P0 Dark app shell with sidebar navigation, n8n-like look (Ph 0) — e2e: every sidebar page, 404 page, collapsible sidebar remembered; manual: screenshots reviewed
- [x] P0 WebSocket connection with session auth + connection indicator (Ph 0) — test: `server/tests/ws.test.ts` (401 without session, rooms, garbage input); e2e: indicator shows Live
- [x] P2 Simple login: owner setup on first run, login, logout, session cookie (Ph 0) — test: `server/tests/auth.test.ts` (validation, single owner, brute-force limit, forged cookie); e2e: setup → sign out → wrong password → deep-link redirect
- [x] P2 `npm run user:reset` to recover a lost owner password (Ph 0) — test: `db.test.ts` (deleteAll cascades sessions); manual: asks to type RESET, `-- --yes` skips it, setup screen returns
- [x] P2 Playwright smoke tests `npm run test:e2e` (Ph 0) — 3 specs pass (`PW_CHANNEL=chrome` uses the installed Chrome)

## Engine (all P0)
- [x] P0 Node registry auto-loads one-file nodes and validates their schema (Ph 1) — test: `nodes.test.ts` (registry), served at `GET /api/node-types` (`api-engine.test.ts`)
- [x] P0 Items data model `{json, binary}` arrays, multiple inputs / outputs per node (Ph 1) — test: `engine.test.ts`
- [x] P0 Paired items (`$('X').item` lineage) (Ph 1) — test: `engine.test.ts` (through IF, Sort, disabled node), `expressions.test.ts`
- [x] P0 Branch execution order (depth-first, top-to-bottom like n8n v1) (Ph 1) — test: `engine.test.ts`; manual: fixture 02
- [x] P0 Multi-input waiting + run with missing inputs when a branch is not taken (Ph 1) — test: `engine.test.ts`; manual: fixture 03
- [x] P0 Loops (node runs multiple times, run index, loop guard) (Ph 1) — test: `engine.test.ts`; manual: fixture 04
- [x] P0 Expressions `{{ }}`: `$json`, `$binary`, `$input`, `$('X')`, `$node["X"].json`, `$items()`, `$prevNode`, `$runIndex`, `$itemIndex` (Ph 1) — test: `expressions.test.ts`
- [x] P0 Expressions: `$now`, `$today`, `DateTime` (Luxon), `$workflow`, `$execution`, `$env`, `$vars` (Ph 1) — test: `expressions.test.ts` (`$vars` values come from the Variables page in Ph 7; secrets are hidden from `$env`)
- [x] P0 Expression helpers: `$jmespath`, `$if`, `$ifEmpty`, `$min`, `$max` + data transformation functions (Ph 1) — test: `expressions.test.ts` (~45 string/array/number/object functions)
- [x] P0 Expression sandbox (AST guard + separate realm + timeout) with clear error messages (Ph 1) — test: `expressions.test.ts` (17 escape attempts incl. constructor, `__proto__`, process, require, computed keys, bridge errors, prototype pollution); manual: preview API
- [x] P0 Node setting: Retry on fail (max tries, wait between tries) (Ph 1) — test: `engine.test.ts`
- [x] P0 Node setting: On error → stop / continue / continue using error output (Ph 1) — test: `engine.test.ts` (whole node and per item), `nodes.test.ts` (Code per item); manual: fixture 05
- [x] P0 Node setting: Always output data (Ph 1) — test: `engine.test.ts`
- [x] P0 Node setting: Execute once (Ph 1) — test: `engine.test.ts`
- [x] P0 Node setting: Disabled (pass-through) (Ph 1) — test: `engine.test.ts`
- [x] P0 Pinned data used by the engine (manual runs only) (Ph 1) — test: `engine.test.ts` (pin/unpin buttons come with the editor, Ph 2)
- [x] P0 Execute single node / partial execution reusing previous data (Ph 1) — test: `engine.test.ts`; manual: `?destinationNode=`
- [x] P0 Execution timeout + cancel (Ph 1) — test: `engine.test.ts`, `api-engine.test.ts`; manual: endless Code loop timed out at 2 s / stopped
- [x] P0 Execution queue with concurrency limit, manual runs first (Ph 1) — test: `api-engine.test.ts`
- [x] P0 Binary data stored on disk + download API with safe headers (Ph 1) — test: `nodes.test.ts`, `api-engine.test.ts`
- [x] P0 Binary data preview in the output panel: "Binary" view (name, type, size, image preview, view / download) and a Files column in the table (Ph 2, done in Ph 4) — e2e: `web/e2e/editor-data-network.spec.ts` (download checked byte for byte)
- [x] P0 Executions persisted with per-node run data + event log (Ph 1) — test: `api-engine.test.ts`; manual: `GET /api/executions`
- [x] P0 Crash recovery: running executions marked `crashed` on boot (Ph 1) — test: `api-engine.test.ts`
- [x] P0 Live execution events over WebSocket (`execution.*`, `node.started/finished` with preview, `edge.data`) (Ph 1) — test: `api-engine.test.ts` (order, seq, previews)
- [x] P0 Expression preview API for the editor (`POST /api/expressions/preview`) (Ph 1) — test: `api-engine.test.ts`; manual: curl
- [x] P2 Dev endpoint `POST /api/dev/run` to run a workflow JSON with curl (disable with `FLOWFORGE_DEV_API=false`) (Ph 1) — test: `api-engine.test.ts` (8 fixtures)
- [x] P0 Error workflow (Error Trigger receives failed execution info, n8n payload) (Ph 3) — test: `server/tests/triggers.test.ts`
- [x] P0 Sub-workflows (Execute Workflow + Execute Workflow Trigger, parent link, depth limit 10) (Ph 3) — test: `server/tests/triggers.test.ts`

## Editor + live visualization (all P0)
- [x] P0 Canvas: drag/drop nodes, connect, delete, pan/zoom (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Multi-select, copy/paste (n8n-style JSON on the clipboard) (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Minimap (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Undo / redo (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Auto-layout (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Cmd/Ctrl+K command palette (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Sticky notes (markdown, colors, resize) (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Node creator panel with search (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Node panel: INPUT / PARAMETERS / OUTPUT with Table + JSON (+ Schema) views (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Parameter forms generated from the node schema (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Expression editor: Fixed/Expression toggle, autocomplete, live preview, drag field from INPUT (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Node settings tab (retry, on error, always output, execute once, notes) (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Save / open workflows, unsaved-changes guard, rename (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Pin / unpin data from the output panel (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Live execution over WebSocket: running nodes glow, success/error state, item counts (Ph 2) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Particles on edges + item-count labels + execution log panel (Ph 2); Ph 8 polish: pulse ring on running nodes, particles scaled by item count (max 8 per edge, 60 in total), green check pop, red shake, preview bubble on hover (≤ 3 items / 2 KB), execution timeline bar with node durations, `prefers-reduced-motion` respected; manual: 50-node workflow run 20 times, heap 31 → 28 MB (no leak) — e2e: `web/e2e/editor-*.spec.ts`; unit: `web/tests/*.test.ts`
- [x] P0 Activate / deactivate workflow with visible status and activation errors (editor + workflows list) (Ph 3) — test: `server/tests/triggers.test.ts` (lifecycle, boot, no leaks); e2e: `web/e2e/editor-triggers.spec.ts`

- [x] P2 Workflows list: create, open, rename, delete (Ph 2) — e2e: `editor-canvas.spec.ts` (tags/search/duplicate: see Product)
- [x] P0 Fallback JSON editor for unknown parameter types (Ph 2) — e2e: `editor-triggers.spec.ts` (a parameter type the editor does not know, simulated by rewriting `/api/node-types`; the JSON stays editable)
- [x] P0 Error card "Open Credentials" button (Ph 2, 3B) — e2e: `editor-credentials-form.spec.ts` (missing credential → dialog creates it and selects it on the node; wrong password → dialog opens the failing credential for editing)

## Triggers
- [x] P0 Manual Trigger (Ph 1) — test: `engine.test.ts`
- [x] P0 Webhook: all HTTP methods, path params (static before dynamic) (Ph 3) — test: `server/tests/webhook.test.ts`
- [x] P0 Webhook: separate test URL (`/webhook-test`, listen 120 s, single shot) and production URL (`/webhook`) (Ph 3) — test: `server/tests/webhook.test.ts`; e2e: editor-triggers
- [x] P0 Webhook response mode: Immediately (custom code / body / headers) (Ph 3) — test: `server/tests/webhook.test.ts`; manual: curl guide A
- [x] P0 Webhook response mode: When last node finishes (first JSON / all / binary / no body; 500 on error) (Ph 3) — test: `server/tests/webhook.test.ts`; manual: curl guide B
- [x] P0 Webhook response mode: Using Respond to Webhook node (clear 500 if none runs) (Ph 3) — test: `server/tests/webhook.test.ts`; manual: curl guide C
- [x] P0 Webhook: JSON / form / multipart (binary) / raw bodies; basic/header auth; CORS; path conflicts refused (Ph 3) — test: `server/tests/webhook.test.ts`
- [x] P0 Webhook Basic / Header Auth use encrypted credentials chosen on the node (no password in the workflow); the checked auth header is `**hidden**` in the output; the session cookie never reaches a workflow; Phase 3 inline passwords are migrated once at startup (Ph 3B) — test: `webhook.test.ts` (authentication), `credentials.test.ts` (upgrade); e2e: `editor-credentials-form.spec.ts`
- [x] P0 Schedule Trigger: interval rules (seconds → months) (Ph 3) — test: `server/tests/triggers.test.ts`; manual: curl guide E
- [x] P0 Schedule Trigger: cron expression (with seconds) + workflow timezone (Ph 3) — test: `server/tests/triggers.test.ts`
- [x] P0 Form Trigger (see Integrations → Form) (Ph 3B) — test: `server/tests/forms.test.ts`; e2e: `editor-credentials-form.spec.ts`
- [x] P0 Telegram Trigger, long polling, no public URL needed (Ph 5) — test: `telegram-hub.test.ts`, `telegram.test.ts`, `examples.test.ts` (local mock of the Bot API). **Not verified with a real key (none available to me): run `npm run check`.**
- [x] P0 Error Trigger (Ph 3) — test: `server/tests/triggers.test.ts`
- [x] P0 Execute Workflow Trigger (Ph 3) — test: `server/tests/triggers.test.ts`
- [x] P2 Chat Trigger: mobile-first chat page `/chat/:id` (QR code, session id, history kept in the browser) + chat panel in the editor; the reply is the output of the last node (Ph 5) — test: `chat.test.ts`; e2e: `web/e2e/editor-chat.spec.ts` (editor panel, then the page at phone size with a mock Gemini); manual: screenshots of the page (390 px) and the panel
- [x] P2 Local File Trigger (add/change/delete, ignore patterns, restricted to `./data/files`) (Ph 3) — test: `server/tests/triggers.test.ts`
- [x] P2 RSS Feed Trigger (Ph 3) — test: `server/tests/triggers.test.ts` (local feed server)
- [x] P2 HTTP polling trigger with dedupe (key field or SHA-256, LRU 5000, baseline on first run) (Ph 3) — test: `server/tests/triggers.test.ts`
- [x] P2 Test mode "Listen for test event" for every trigger type (Ph 3/5) — webhook, form (5 minutes, `forms.test.ts`), schedule, RSS / HTTP poll, file trigger (`triggers.test.ts`, e2e), Telegram (`telegram.test.ts`: one update, then the listener closes), Chat (`chat.test.ts`: one message per listen, used by the editor chat panel)

- [x] P0 Public routes are safe: rate limit per IP, body size limit (413), path length limit, malformed URLs → 4xx, never crash (Ph 3) — test: `server/tests/webhook.test.ts`
- [x] P2 Workflow settings dialog: error workflow, timezone, execution timeout, save production runs (Ph 3) — e2e: `editor-triggers.spec.ts`

## Flow nodes
- [x] P0 IF (Ph 1) — test: `engine.test.ts`, `conditions.test.ts` (shared condition engine, strict/loose types)
- [x] P0 Switch (rules + expression mode, fallback output) (Ph 1) — test: `nodes.test.ts`; manual: fixture 07
- [x] P0 Merge: append, combine by matching fields (5 join modes), by position, all combinations, choose branch (Ph 1) — test: `engine.test.ts`; manual: fixtures 03, 06
- [x] P0 No Operation (Ph 1) — test: `engine.test.ts`
- [x] P0 Sticky Note (Ph 2) — e2e: `editor-canvas.spec.ts`
- [x] P2 Filter (kept / discarded) (Ph 1) — test: `nodes.test.ts`
- [x] P2 Loop Over Items (Ph 1) — test: `engine.test.ts`; manual: fixture 04
- [x] P2 Stop and Error (Ph 1) — test: `nodes.test.ts`; manual: fixture 08
- [x] P2 Wait: interval, specific time, webhook resume, form resume (server-side validation); persisted across restart (Ph 3) — test: `server/tests/triggers.test.ts` (incl. stop → restart → resume); e2e: editor-triggers; manual: curl guide F, G
- [x] P2 Execute Workflow (database / JSON source, once / per item, wait or not) (Ph 3) — test: `server/tests/triggers.test.ts`

## Data nodes
- [x] P0 Set / Edit Fields (manual mapping + JSON mode) (Ph 1) — test: `nodes.test.ts`
- [x] P0 Code (sandboxed JS, QuickJS in worker threads; all items / each item; time + memory limits) (Ph 1) — test: `nodes.test.ts` (no require/process/fetch, endless loop, memory bomb, cancel, line numbers). Known gap: Luxon `DateTime` is not available inside Code (QuickJS has no Intl)
- [x] P2 Limit (Ph 1) — test: `nodes.test.ts`
- [x] P2 Sort (Ph 1) — test: `nodes.test.ts`
- [x] P2 Aggregate: individual fields (rename, merge lists, keep missing) or all item data (all / some / all except) (Ph 4) — test: `server/tests/data-nodes.test.ts`
- [x] P2 Split Out: one or several list fields, keep other fields, destination name; missing field per item with On Error (Ph 4) — test: `server/tests/data-nodes.test.ts`
- [x] P2 Remove Duplicates: all fields / except / selected, ignore case; duplicates on a second output (Ph 4) — test: `server/tests/data-nodes.test.ts`
- [x] P2 Summarize: sum, average, min, max, count, count unique, append, concatenate; split by fields; separate items or single item (Ph 4) — test: `server/tests/data-nodes.test.ts`; e2e: `editor-data-network.spec.ts`
- [x] P2 Compare Datasets (2 inputs, 4 outputs): match fields, resolve differences (both / A / B / mix), fuzzy compare, skip fields, all matches (Ph 4) — test: `server/tests/data-nodes.test.ts`
- [x] P2 Date & Time (Luxon): add / subtract, format (presets, custom, timestamps), time between dates, round, extract part, convert time zone, current date (Ph 4) — test: `server/tests/data-nodes.test.ts` (workflow time zone, many input formats, unreadable dates per item); e2e: form follows the operation
- [x] P2 Crypto: hash (MD5, SHA…; text or file), HMAC, random string, UUID (Ph 4) — test: `server/tests/data-nodes.test.ts` (known test vectors)
- [x] P2 HTML: extract with CSS selectors (cheerio: text, HTML, attribute, value, lists; JSON field or file), generate HTML from a template with expressions, convert items to an HTML table (Ph 4) — test: `server/tests/data-nodes.test.ts`
- [x] P2 XML ↔ JSON (xml2js options: attributes, lists, root, trim…) (Ph 4) — test: `server/tests/data-nodes.test.ts` (round trip, invalid XML)
- [x] P2 Markdown ↔ HTML (Ph 4) — test: `server/tests/data-nodes.test.ts`
- [x] P2 Convert to File: CSV (delimiter, header, BOM), JSON (one file or one per item), HTML table, text, Base64 string to file (Ph 4) — test: `server/tests/file-nodes.test.ts`; e2e: CSV content checked
- [x] P2 Extract from File: CSV (typed values, detected delimiter, no header), JSON, text, file to Base64 (Ph 4) — test: `server/tests/file-nodes.test.ts` (round trip with Convert to File, broken files)
- [x] P2 Read/Write Files from Disk, restricted to `./data/files`: read one file or a pattern (`*`, `**`, `{a,b}`), write, append; `..`, absolute paths elsewhere and symlinks out of the folder are refused (Ph 4) — test: `server/tests/file-nodes.test.ts`
- [x] P2 Execute Command — **disabled by default** with a clear error; enabled only by the Settings → Security toggle (confirmation, logged, survives restart); exit code / stdout / stderr, timeout, once or per item (Ph 4) — test: `file-nodes.test.ts`, `server/tests/settings.test.ts`; e2e: `editor-data-network.spec.ts`

## Network nodes
- [x] P0 HTTP Request: all methods, headers, query, body types (JSON, form, multipart, raw, binary) (Ph 4) — test: `server/tests/http-request.test.ts` (local mock server); manual: GitHub API
- [x] P0 HTTP Request: auth none / basic / bearer / API key (header or query) through encrypted credentials, with a selector per type on the node; secrets redacted from errors and never stored (Ph 4) — test: `server/tests/http-request.test.ts` (local mock server); e2e: `editor-data-network.spec.ts` (all four types)
- [x] P0 HTTP Request: pagination (update a parameter with `$pageCount`, next URL from `$response`; stop on empty / status / expression; page limit, interval), timeout, full response, response format (autodetect / JSON / text / file) (Ph 4) — test: `server/tests/http-request.test.ts` (local mock server); e2e: pagination; manual: 100 posts from jsonplaceholder in 5 pages
- [x] P0 HTTP Request: follow redirects (limit, 303 → GET, credentials not forwarded to another host), ignore SSL issues, never error, retry on fail, cancel, clear errors (status + body + hint, refused, timeout, bad URL) (Ph 4) — test: `server/tests/http-request.test.ts` (local mock server) (incl. self-signed HTTPS server)
- [x] P0 Respond to Webhook (all items, first item, JSON, text, binary, redirect, no data; status + headers) (Ph 3) — test: `server/tests/webhook.test.ts`
- [x] P2 HTTP Request: import cURL (bash / PowerShell / cmd quoting, headers, JSON / form / multipart / raw bodies, `-G`, `-u`; tokens become a credential) (Ph 4) — unit: `web/tests/curl.test.ts`; e2e: `editor-data-network.spec.ts`
- [x] P2 GraphQL: query, variables, operation name, POST / GET, headers, same credentials as HTTP Request; GraphQL `errors` fail the node (Ph 4) — test: `server/tests/http-request.test.ts` (local mock server); manual: countries.trevorblades.com

## Credentials
- [x] P0 Credentials manager: AES-256-GCM encrypted storage (Ph 3B) — test: `server/tests/credentials.test.ts` (round trip, fresh IV, tampering and wrong key detected, payload bound to its credential id, key file 0600, **raw database bytes contain no credential value**, a key change is reported instead of crashing)
- [x] P0 Secrets are write-only: never in API responses, execution data, stored events, logs or the page (Ph 3B) — test: `credentials.test.ts` (secrets never leak); e2e: `editor-credentials-form.spec.ts` (page HTML + API after reload, stored execution)
- [x] P0 Credentials page: create / edit / delete, type picker, fields generated from the credential type schema, quick-setup presets, default per type (Ph 3B) — test: `credentials.test.ts` (API, validation, defaults); e2e: `editor-credentials-form.spec.ts`; manual: screenshots reviewed
- [x] P0 Test button per credential type (Ph 3B) — test: `credentials.test.ts` (unsaved values, saved credential, editing with the saved secret, `.env`, unreachable server); e2e: dialog + list row
- [x] P0 Lookup order: credential selected on the node → default of the type → `.env` → `MissingCredentialError` (Ph 3B) — test: `credentials.test.ts` (lookup order; also by name for imported workflows)
- [x] P0 `.env` fallback when no credential is selected (Ph 3B) — test: `credentials.test.ts`, `send-email.test.ts` (.env fallback)
- [x] P0 Missing key ⇒ clear error in the UI with "Open Credentials" action, never a crash (Ph 3B) — test: `send-email.test.ts` (error carries type, `.env` variable, docs anchor); e2e: `editor-credentials-form.spec.ts`
- [x] P0 Credential selector on nodes that need one, with "Create new credential…" and edit (Ph 3B) — e2e: `editor-credentials-form.spec.ts` (Send Email, Webhook Basic Auth)

## Required integrations (all P0)
### 1. Send Email (SMTP)
- [x] P0 SMTP credential (Gmail App Password / Brevo presets) with Test button (`transporter.verify`) (Ph 3B) — test: `credentials.test.ts` (Test button against a local SMTP server); e2e: presets + Test. **Not verified by me against real Gmail / Brevo (no key): run `npm run check:email` with your App Password.**
- [x] P0 Send Email node: from, to (several), cc, bcc, reply-to, subject, text / HTML / both, expressions per item, attachments from binary (Ph 3B) — test: `server/tests/send-email.test.ts`, `forms.test.ts` (uploaded file attached), all against a local SMTP server
- [x] P0 Nice responsive HTML email template: title, message, optional button, footer, accent colour + text version (Ph 3B) — test: `send-email.test.ts` (template, escaping, safe URLs); manual: both example emails rendered at desktop and phone width
- [x] P0 Send Email errors: per-item errors follow "On Error"; clear messages for missing credential, wrong password (names the credential), timeout, refused connection, unknown host, TLS mismatch (Ph 3B) — test: `send-email.test.ts`
- [x] P0 `npm run check:email` sends a real test email with the saved credential or `.env` and prints OK / FAIL with the reason (Ph 3B) — manual: OK with `.env` values and with a saved credential, FAIL for wrong password / nothing configured / unknown credential / refused connection (local SMTP server)
### 2. HTML Form Generator
- [x] P0 Visual form builder: add, drag to reorder, edit, delete; text, email, number, long text, select, radio, checkboxes, date, file upload, hidden, password; label, placeholder, required, default value, help text, options (Ph 3B) — unit: `web/tests/form-fields.test.ts`; e2e: `editor-credentials-form.spec.ts` (add, edit, delete, arrows, drag and drop, duplicate-label warning)
- [x] P0 3 form themes + live preview next to the builder (phone / desktop frame), same HTML as the public page (Ph 3B) — unit: `shared/tests/forms.test.ts`, `web/tests/form-fields.test.ts`; e2e: preview follows every change; manual: screenshots of the 3 themes with every field type
- [x] P0 Public mobile-first page `/form/:id` (+ `/form-test/:id`, single shot while listening) (Ph 3B) — test: `server/tests/forms.test.ts`; e2e: filled in a 390 px viewport; manual: phone-size screenshots
- [x] P0 Form title, description, button text, success message or redirect URL, success page with confetti; confirmation right away or when the workflow finishes (Ph 3B) — test: `forms.test.ts` (confirmation, redirect, no internal error details on the production form)
- [x] P0 QR code of the form URL: PNG generated locally, big view, copy URL, download (Ph 3B) — test: `forms.test.ts` (valid PNG structure, sizes, download header, login required); e2e: dialog + download
- [x] P0 Form URL uses `PUBLIC_URL` or the detected LAN address, with a hint when a phone cannot reach it (Ph 3B) — test: `forms.test.ts` (system info); e2e: localhost warning. **Scanning with a real phone is for you to try** (see README "Open FlowForge from a phone")
- [x] P0 Server-side validation from the field schema: 400 with an error per field, shown next to the fields (Ph 3B) — test: `forms.test.ts` (every type, with and without JavaScript), `shared/tests/forms.test.ts`; e2e
- [x] P0 Submission triggers the workflow: answers become `$json`, uploaded files become binary data (Ph 3B) — test: `forms.test.ts`; e2e (test form + production form + stored execution)
- [x] P0 Public form protection: rate limit per IP, upload size limit (413), honeypot field (Ph 3B) — test: `forms.test.ts`
- [x] P0 Wait node "On Form Submitted" uses the same builder, themes and page (replaces the JSON editing of Ph 3) (Ph 3B) — test: `forms.test.ts` (Wait node form), `triggers.test.ts`; e2e
- [x] P0 Example "Contact form → emails": form → admin notification + designed confirmation to the submitter → confirmation page, importable from Workflows → Examples (Ph 3B) — test: `forms.test.ts` (example); e2e: import
### 3. Telegram
- [x] P0 Telegram credential (bot token, default chat id) with Test button (`getMe`), `.env` fallback `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (Ph 5) — test: `telegram.test.ts`, `check.test.ts`; manual: a wrong token against the real Telegram API gives "Telegram rejected the bot token". **Not verified with a real key (none available to me): run `npm run check`.**
- [x] P0 Telegram: send message (text, HTML / Markdown / MarkdownV2, inline keyboard with callback and URL buttons) (Ph 5) — test: `telegram.test.ts` (payloads, default chat id, 400 parse error, 401, 429 retry, timeout, malformed answer, token never in results or logs). **Not verified with a real key (none available to me): run `npm run check`.**
- [x] P1 Telegram: send photo / document (binary upload or URL), edit message text, delete message, answer callback query, get chat (Ph 5) — test: `telegram.test.ts` (multipart upload checked byte for byte). **Not verified with a real key (none available to me): run `npm run check`.**
- [x] P0 Telegram Trigger (long polling via shared TelegramHub): ONE poller per bot shared by all workflows, `getUpdates` timeout 25 s, offset kept in static data, exponential backoff, `deleteWebhook` first, command filter (`/weather Paris` ⇒ `command`, `args`), chat / user allow lists, clear message when another program polls the bot (409) (Ph 5) — test: `telegram-hub.test.ts` (max 1 concurrent `getUpdates` for 2 subscribers and for 2 active workflows, offset persistence, backlog skipped, backoff + recovery, clean shutdown, no duplicates after activating twice). **Not verified with a real key (none available to me): run `npm run check`.**
### 4. Discord
- [x] P0 Discord webhook credential with Test button (GET, posts nothing), `.env` fallback `DISCORD_WEBHOOK_URL` (Ph 5) — test: `discord.test.ts`, `check.test.ts`; manual: an unknown webhook against the real Discord API gives "Discord does not accept this webhook (Unknown Webhook)". **Not verified with a real key (none available to me): run `npm run check`.**
- [x] P0 Discord: message with content, username, avatar and rich embeds (title, description, URL, color, author, fields, footer, thumbnail, image, timestamp), `?wait=true`, threads; 2000 character / 10 embed / 6000 total limits checked before sending (option: truncate); 429 honours `retry_after` (Ph 5) — test: `discord.test.ts`, `examples.test.ts`. **Not verified with a real key (none available to me): run `npm run check`.**
- [x] P1 Discord: edit, delete and get a message sent by the webhook (Ph 5) — test: `discord.test.ts`. **Not verified with a real key (none available to me): run `npm run check`.**
### 5. Open-Meteo
- [x] P0 Weather node: current, daily and hourly forecast by city or coordinates, units (°C/°F, km/h, m/s, mph, kn, mm/inch), time zone, weather-code text + emoji, one-line readable summary (Ph 5) — test: `open-meteo.test.ts` (mock), `examples.test.ts`; manual: **real Open-Meteo call** from the editor's server (Casablanca) and in `npm run check` (Paris)
- [x] P0 Geocoding by city name, also "City, Country" (no key needed) + Search Location operation (Ph 5) — test: `open-meteo.test.ts`; manual: real calls (`Paris, Texas`, `Springfield, IL`, `Casablanca, Morocco`)
### 6. Google Gemini
- [x] P0 Gemini credential (API key in the `x-goog-api-key` header, default model) with Test button (tiny prompt), `.env` fallback `GEMINI_API_KEY` / `GEMINI_MODEL` (Ph 5) — test: `gemini.test.ts`, `check.test.ts`; manual: a wrong key against the real Gemini API gives "The Gemini API key is not valid". **Not verified with a real key (none available to me): run `npm run check`.**
- [x] P0 Gemini node: prompt, system instruction, model choice (default `gemini-3.8-flash`), temperature, max output tokens, top P / K, JSON mode (parsed `json` output), images from binary data, retries on 429 / 500 / 503, clear errors for 400 / 403 / 404 / 429 / safety blocks / empty answers (Ph 5) — test: `gemini.test.ts` (mock). **Not verified with a real key (none available to me): run `npm run check`.**
- [x] P1 Gemini conversation memory per chat session (table `chat_memory`, scoped per workflow) (Ph 5) — test: `chat.test.ts`, `examples.test.ts`; e2e: `web/e2e/editor-chat.spec.ts`

## AI (P1)
- [x] P1 AI Agent (cluster node with 3 slots under it: Chat Model, Memory, Tool) with the Gemini Chat Model sub-node; tool loop with Gemini function calling (thought signatures resent unchanged), at most 8 model calls, the last one without tools; tool errors, unknown tools and tool timeouts go back to the model; clear error when no model is attached; each sub-node shows its own runs (Ph 6) — test: `ai-engine.test.ts`, `ai-agent.test.ts`, `examples.test.ts` (weather question answered through the Weather Tool); e2e: `web/e2e/editor-builder.spec.ts` (agent + model run); manual: slots and sub-nodes on the canvas (screenshots). **Not verified with a real Gemini key (none available to me).**
- [x] P1 Simple Memory sub-node: last N messages per session in `chat_memory`, one memory per workflow and session (Ph 6) — test: `ai-agent.test.ts` (context kept between 2 messages, sessions apart, nothing saved on failure), `examples.test.ts` (one memory per Telegram chat)
- [x] P1 Tools for the agent, each with a name, a description and a JSON schema: Weather Tool (Open-Meteo), Calculator (mathjs, dangerous functions disabled, 1 s time limit), HTTP Request Tool (the model fills only `{placeholders}` and declared parameters, never the server; credentials supported), Code Tool (QuickJS sandbox) (Ph 6) — test: `ai-tools.test.ts`
- [x] P1 AI Workflow Builder: prompt bar on the canvas with 6 suggestions; Gemini JSON → validation against the node registry (types exist, parameters, connections and output indexes, slots, at least one trigger) → one retry with the error list → layout; never returns an unknown node type; the prompt holds the node catalog and the user's text only (Ph 6) — test: `ai-builder.test.ts` (repair, bad JSON, unknown types, generated workflow runs, no secret in the prompt or logs); e2e: `web/e2e/editor-builder.spec.ts`. **Not verified with a real Gemini key (none available to me).**
- [x] P1 Builder: nodes appear one by one with a pop animation, connections draw themselves, one undo step; warning badge on nodes whose credential is missing (`POST /api/credentials/missing`) (Ph 6) — test: `credentials-missing.test.ts`; e2e: `web/e2e/editor-builder.spec.ts` (nodes appear, workflow runs); manual: screenshots of the drawing and the badges
- [x] P1 Builder: offline fallback (no key, 429, timeout, 5xx, blocked or invalid answer) to the closest template by keywords + TF-IDF, labelled "Offline: closest template" with the reason; weak matches are flagged (Ph 6) — test: `ai-builder.test.ts` (10 sample prompts), `ai-builder-suggestions.test.ts` (the 6 suggestions pick the right template); manual: real run without a key from a suggestion chip

## Product
- [x] P1 Version history: a version per save that changes something (pinData ignored, max 100), optional note (Shift+click Save), history drawer with +added −removed ~changed per version, preview, restore = new version (re-activates an active workflow) (Ph 7) — test: `versions.test.ts`, `shared/tests/version-diff.test.ts` (no secret in versions); manual: history drawer opened in the editor (screenshot). Restore was clicked only through the API tests, not in the UI
- [x] P2 Workflows list: search (name + tags), tags (create / rename / delete / assign / filter), active filter, sort, status dot = last execution, duplicate, bulk delete, filters kept in the URL (Ph 7) — test: `workflows-product.test.ts`; e2e: `web/e2e/product-workflows.spec.ts` (tag + search + duplicate); manual: list with tag chips and red status dot (screenshot)
- [x] P2 Import / export workflow JSON: export file keeps only `{id, name}` credential references; import from a file or pasted JSON resolves references by id then name, reports missing ones, fresh webhook ids, tags by name (Ph 7) — test: `workflows-product.test.ts` (export → import round trip with a saved credential, secret never in the file); manual: real export of a workflow using a header-auth credential: secret absent, reference kept, re-import resolved it
- [x] P2 Executions page: filters (workflow, status, mode, date range), "Load more" pagination, bulk delete; detail page with nodes in run order, INPUT / OUTPUT (Schema / Table / JSON), error card, delete, open workflow; the editor shows the last run again after a reload (or `?execution=<id>`) (Ph 7) — test: `executions-api.test.ts`; e2e: `web/e2e/product-executions.spec.ts`; manual: detail of a Set → Code run (screenshot)
- [x] P2 Retry a failed execution: from the failed node (every node that succeeded is reused, all branches after the failure run) or from the start; linked with "Retry of #N" (Ph 7) — test: `executions-api.test.ts` (single chain, several branches and leaves, rerun all, 400 / 404); manual: Retry button on a failed run → Start and Prepare `reused`, failed node re-ran with success
- [x] P2 Variables page (create / edit / delete, copy `{{ $vars.key }}`) feeding `$vars` in expressions, the expression preview, the Code node and the Code Tool (Ph 7) — test: `variables.test.ts` (expression + Code node, both modes); manual: variable added from the page; a Set `{{ $vars.city }}` and a Code node `$vars.city` both returned Paris
- [x] P2 Settings page: time zone, default timeout, concurrency (applied at once), save data of successful / failed / manual runs, retention (days, max count, Prune now), `$env` access, Execute Command toggle; shows the value in effect (Settings first, then `.env`) (Ph 7) — test: `settings.test.ts`, `pruning.test.ts` (never deletes queued / running / waiting); e2e: Execute Command toggle; manual: page reviewed, Prune now clicked (toast)
- [x] P2 Templates gallery: 7 examples + 7 new templates + the AI builder templates, search, category chips, graph preview, one-click import that opens the editor (Ph 7) — test: `templates.test.ts` (every template imports and uses only registered node types); manual: gallery reviewed, "Use template" opened the editor
- [x] P2 Dashboard (Overview): executions per day for 14 days (stacked success / error / other), success rate, average duration, active workflows, top failing workflows, recent executions, integrations health (credentials saved / from `.env` / missing) (Ph 7) — test: `dashboard.test.ts` (zero days, rates, no secret); manual: dashboard with 1 success + 1 failure (screenshot)

## Wow
- [x] P1 Time-travel debugger: open any past execution on the canvas (**Time travel** on an execution page or in the log), prev / next / play / speed, scrubber coloured by status, ←/→/Space/Esc; at step k the canvas shows what had run and edge counts, the panel shows that step's input / output / duration / error; loops, failed and waiting runs; **Re-run from here** = new run reusing the earlier results; never writes to the stored execution (Ph 8) — test: `shared/tests/timeline.test.ts` (linear, branch, loop, failed, waiting), `server/tests/timetravel.test.ts` (`rerunFrom`), `web/tests/timeline-edge-key.test.ts`; e2e: `web/e2e/product-timetravel.spec.ts`. Limit: a deleted workflow cannot be replayed on the canvas (its execution page still shows every node's data)
- [x] P1 Demo Mode (sidebar + Overview): AI build (Gemini, else offline template, else built-in showcase) → form QR code → wait 20 s or simulate a real submission ("Simulating a submission") → live run → results card (sent / simulated / failed); **Skip step**, **Stop demo**; a node without its credential returns `_simulated: true` output with the orange SIMULATED badge ONLY in demo runs (only the demo routes can set the flag; any other error stays an error) (Ph 8) — test: `server/tests/demo.test.ts` (no keys, Gemini down, no submission, normal run / `demo` in the body / in the workflow JSON → clear missing-credential error), `web/tests/demo-script.test.ts`; e2e: `web/e2e/product-demo.spec.ts` (end to end without keys)

## Deliverables
- [ ] P0 README.md (install, run, features, troubleshooting) (Ph 8)
- [ ] P0 README: Teacher demo script (exact 5-minute click sequence) (Ph 8)
- [ ] P0 README: Cloudflare quick tunnel fallback (`cloudflared tunnel --url http://localhost:5679`) (Ph 8) — section "Open FlowForge from a phone" written in Ph 3B; not yet tried with a real tunnel
- [ ] P0 README: Fedora firewall command to reach the app from a phone (Ph 8) — written in Ph 3B (Fedora, Ubuntu, Windows, macOS); not yet tried from a real phone
- [x] P0 `.env.example` with every variable commented (Ph 0, completed in Ph 5) — test: `check.test.ts` and the integration tests read the same variable names through the `.env` fallback
- [x] P0 API_SETUP.md for the 6 integrations (links, steps, free limits or "not verified", `.env` name + Credentials page field, how to verify, troubleshooting table) (Ph 5) — manual: every link opened (HTTP 200), endpoints and limits taken from the official docs on 2026-10-12. The steps inside Telegram, Discord and AI Studio were **not walked through by me** (no account)
- [x] P0 `need.md`: checklist of everything to provide (summary table, keys one by one, machine, first run, `.env` template, demo-day checklist, top 10 problems) (Ph 5) — manual: read against the code (variable names, credential field names, startup banner, menu labels). To be updated in the final phase
- [x] P0 `npm run check`: real call per integration (SMTP verify + email to `CHECK_EMAIL_TO`, forms self-test on a private server, Telegram `getMe` + message to `TELEGRAM_CHAT_ID`, Discord GET / `--send`, Open-Meteo Paris, Gemini "Reply OK"), table of OK / FAIL (reason) / SKIP (what to set where), exit code 1 on FAIL, never prints secrets; uses the same `test()` as the Test buttons (Ph 5) — test: `check.test.ts` (mocks); manual: real run without keys (Forms OK, Open-Meteo OK, 4 SKIP, exit 0) and with wrong keys against the real services (3 FAIL with the right reason, exit 1, no secret printed). **The OK path with real keys is not verified by me.**
- [x] P0 `/examples`: the 8 planned workflows (+3 more), importable from Workflows → Examples and Templates: form → emails, daily weather → HTML email, contact form → Discord embed + email, Telegram `/weather` assistant, website chatbot (Gemini), Telegram AI assistant, website chatbot with AI Agent, REST API webhook (Switch / IF / Respond to Webhook), RSS → Discord digest, CSV pipeline, resilience demo (3 linked workflows: retry, continue on fail, error output, Error Trigger, sub-workflow) (Ph 3B–8) — test: `examples.test.ts` (every example imported and run end to end against the mocks)
