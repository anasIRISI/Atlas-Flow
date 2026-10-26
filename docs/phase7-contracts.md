# Phase 7 contracts — product layer

Everything is behind login (`requireAuth` in `server/src/api/index.ts`). Errors use the central handler
(`HttpError`, `notFound`, zod errors → 400). Shared types: `shared/src/product.ts`, `shared/src/settings.ts`.
Patterns to copy: list page `web/src/pages/WorkflowsPage.tsx` / `CredentialsPage.tsx` (loading = `Spinner`,
error = `Alert`, empty state card), form page `SettingsPage.tsx`, API router `server/src/api/credentials.ts`,
repo `server/src/db/repositories/credentials.ts`, API tests `server/tests/workflows-api.test.ts` (`makeTestApp`).

Already wired by the orchestrator (do not re-create): migrations 7–9, stub routers mounted in `api/index.ts`,
stub repos in `context.ts` (`tagsRepo`, `versionsRepo`, `variablesRepo`), stub pages + routes in `App.tsx`,
`StartOptions.retryOf`, `ExecutionsRepo.create({ retryOf })`, `ExecutionService.setMaxConcurrent()`,
`ExecutionServiceOptions.runtime?: () => RuntimeSettings`, `versionsRepo.record()` calls in POST/PUT workflows
and in examples import.

## DB (migrations.ts, already added)
- 7 `tags(id, name UNIQUE NOCASE, created_at, updated_at)`, `workflow_tags(workflow_id, tag_id)` (cascade).
- 8 `workflow_versions(id, workflow_id, version_id, number, name, nodes, connections, settings, hash, source, note, restored_from, created_at)`, unique (workflow_id, number).
- 9 `variables(id, key UNIQUE, value, created_at, updated_at)`; indexes `executions(created_at)`, `executions(status, id DESC)`.

## W1 — Workflows list, tags, import/export, bulk delete
- `GET /api/workflows` → `WorkflowSummary[]` now with `tags`, `lastExecutionStatus`, `lastExecutionAt` (one query, no N+1).
- `GET /api/tags` → `Tag[]` with `usageCount`; `POST /api/tags {name}` (1–32 chars, trimmed; duplicate name → 409);
  `PATCH /api/tags/:id {name}`; `DELETE /api/tags/:id` (removes links).
- `PUT /api/workflows/:id/tags {tagIds: string[]}` → `WorkflowSummary`-ish `{ tags }`; unknown tag id → 400.
- `POST /api/workflows/:id/duplicate {name?}` → new `WorkflowRecord` (inactive, "<name> (copy)" unique, same tags,
  fresh node `webhookId`s, pinData kept), records a version `source: 'create'`.
- `GET /api/workflows/:id/export` → `WorkflowExport` with `Content-Disposition: attachment; filename="<slug>.json"`.
  Credentials: each `node.credentials[type]` is reduced to `{ id, name }` (a reference). No pinData, no staticData,
  no ids of the instance except node ids. Nothing from the credentials table is ever read into the file.
- `POST /api/workflows/import` body = workflow JSON (n8n-like, our export, or `{ workflow: … }`) → 201
  `ImportWorkflowResponse`. Validates with `WorkflowBodySchema`; unique name; fresh `webhookId`s; inactive;
  tags by name (created if missing); credential refs kept, resolved by id then by name; refs that do not exist →
  `missingCredentials`. Any secret-looking value inside `credentials` refs (anything other than id/name) is dropped.
  Records version `source: 'import'`. Bad JSON / not a workflow → 400 with a clear message.
- `POST /api/workflows/delete {ids: string[]}` (1–200) → `{ deleted: number }`; deactivates first (like DELETE /:id).
- UI `WorkflowsPage.tsx`: search box (name + tag names), tag chips filter (multi), active filter (all/active/inactive),
  sort (last updated / name / created), "updated x ago", status dot = last execution status (green/red/blue/grey),
  row menu: open, rename, duplicate, export, tags…, delete; checkbox column + bulk delete bar; "Import" button →
  dialog with file picker and a paste textarea; tag manager (create/rename/delete) in a popover.
  Filters live in the URL (`?q=&tags=&active=&sort=`). Editor TopBar: tags shown + "Export" in its menu is optional.
- Tests: `server/tests/workflows-product.test.ts` (tags CRUD + bad input, assign, duplicate, export has no secrets,
  **export → import round-trip with a real credential: secret never in the file, refs resolved**, bulk delete,
  import bad input). E2E: `web/e2e/product-workflows.spec.ts` — tag + search + duplicate.

## W2 — Versions
- `VersionsRepo.record(wf, {source, note?, restoredFrom?})`: hash = sha256 of stable JSON of `{name, nodes, connections, settings}`
  (node positions included, pinData excluded); skip if equal to the latest version; number = last + 1. Keep at most 100
  versions per workflow (oldest dropped, but never version 1? → no, simply the oldest).
- `GET /api/workflows/:id/versions` → `WorkflowVersionSummary[]` newest first, each with `diff` vs the previous one.
- `GET /api/workflows/:id/versions/:number` → `WorkflowVersionDetail`.
- `POST /api/workflows/:id/versions/:number/restore {note?}` → restores name/nodes/connections/settings into the workflow
  (`workflowsRepo.update`, keep pinData), records a new version `source: 'restore', restoredFrom: number`,
  reactivates if active (`activeWorkflows.reactivateIfActive`), returns the `WorkflowRecord`.
- `PATCH /api/workflows/:id/versions/:number {note}` (≤ 200 chars) edits the note.
- Pure diff `shared/src/version-diff.ts` `diffWorkflows(prev, next): VersionDiff` — nodes matched by `id` (rename = same id,
  new name), fields compared: type, typeVersion, parameters, credentials, disabled, settings fields (retryOnFail, onError…),
  notes, position (reported as "position"). Unit tests in `shared/tests/version-diff.test.ts`.
- Save note: `PUT /api/workflows/:id` accepts optional `versionNote` (already read in the route). Editor: the Save button
  stays one click; a small "Save with note…" in the TopBar menu (or Shift+click) asks for the note.
- UI: `web/src/editor/HistoryDrawer.tsx`, a History (clock) button in `TopBar.tsx` opens a right drawer: list of versions
  (number, time ago, source badge, note, "+2 −1 ~3" diff summary, expandable to the node names), Restore (confirm dialog;
  if the editor is dirty warn that unsaved changes are lost), "Preview" = read-only JSON or node list. After restore
  reload the workflow into the store.
- Tests: `server/tests/versions.test.ts` (no version when nothing changed, note, restore creates a new version, 404s,
  bad number, cascade on workflow delete, credentials in versions are only `{id,name}` refs as stored in the workflow).

## W3 — Executions
- `GET /api/executions` query `ExecutionListQuery` (`status`/`mode` comma lists, `from`/`to` ISO, `limit`, `cursor`) →
  `ExecutionPage`. Invalid status/mode/date → 400. Keep backward compatibility: the editor and existing tests call
  `GET /api/executions?workflowId=&limit=` and read an array → **move the old array form to `?format=array`?** No: change
  every existing caller (grep `'/executions'` in web/src and server/tests) to the new `ExecutionPage` shape.
- `DELETE /api/executions/:id` (running/queued/waiting → 409 "stop it first"); `POST /api/executions/delete {ids}` →
  `{deleted}` (skips running/waiting). Binary data of deleted executions removed (`binaryStore.deleteExecution`).
- `POST /api/executions/:id/retry RetryExecutionRequest` → 202 `{executionId}`; only `error | crashed | canceled`,
  else 400. Mode `retry`, `retryOf` set. `fromFailedNode` (default true): start from the failed node reusing the
  previous run data of the nodes before it (see how the editor's partial run uses `startNode` / `destinationNode` /
  `previousRunData` in `engine/runner.ts`); `useCurrentWorkflow` uses the saved workflow (404 if deleted).
- `POST /api/executions/prune` → `PruneResult` (runs the pruner now).
- Pruner `server/src/engine/pruning.ts` `pruneExecutions(db/repo, settings, now): number` — deletes finished executions
  (`success | error | canceled | crashed`) older than `pruneMaxAgeDays` and beyond the newest `pruneMaxCount`; manual
  executions when `saveDataManual = 'none'` once older than 10 minutes. **Never** `queued | running | waiting`.
  Started at `app.boot()` and every 10 min (timer `unref()`, cleared in `close()`). Unit tests `server/tests/pruning.test.ts`.
- UI `ExecutionsPage.tsx`: filters (workflow select, status chips, mode select, date range), table (status badge, workflow,
  mode, started, duration, id), "Load more" (cursor), auto-refresh while something is running (WS events
  `execution.*` or 5 s poll), checkbox bulk delete, empty / loading / error states. Row → `/executions/:id`.
- UI `ExecutionDetailPage.tsx`: header (status, workflow link "Open workflow", mode, started, duration, retry-of link),
  left: nodes in run order (from `events`) with status + item counts; right: selected node INPUT and OUTPUT using
  `editor/ndv/DataView.tsx` (table/JSON) and the error with `editor/ndv/ErrorCard.tsx` when it failed. Buttons: Retry
  (from failed node / from start), Delete, "Open in editor" → `/workflow/:id?execution=<id>`.
- Editor restore after reload: `EditorPage` loads `?execution=<id>` if given, else the latest execution of the workflow
  (`limit=1`), and calls `editor.finishFromDetail(detail)` so node colours, item counts and NDV outputs come back. Ignore
  runData of nodes that no longer exist.
- Tests: `server/tests/executions-api.test.ts` (filters, pagination, bad input, delete rules, retry from failed node
  reuses data and sets retryOf, retry of a success → 400, prune endpoint). E2E: `web/e2e/product-executions.spec.ts` —
  run a workflow, open it in Executions, see per-node data.

## W4 — Variables + Settings
- `GET /api/variables` → `Variable[]` (sorted by key); `POST {key, value}` (key `/^[A-Za-z_][A-Za-z0-9_]{0,63}$/`, value
  ≤ 10 000 chars, duplicate → 409); `PATCH /:id {key?, value?}`; `DELETE /:id`.
- `$vars` = all variables as `Record<string,string>`, read at the start of each execution through
  `ExecutionServiceOptions.runtime` (implemented in `app.ts`), also in `/api/expressions/preview`, the Code node and the
  Code Tool (today `code.node.ts` passes `vars: {}` and `env: null`: expose the run's variables / env on `ExecuteContext`).
  Expression autocomplete in the editor lists `$vars.<key>`.
- Settings: `InstanceSettings` (shared) is final. `GET /api/settings` → `SettingsResponse` (with `effective`);
  `PATCH /api/settings` strict zod: timezone must be a valid IANA zone or ''; timeout 0–86 400; concurrency 0–50;
  `allowEnvAccess` boolean|null; policies `'all'|'none'`; `pruneMaxAgeDays` 0–3650; `pruneMaxCount` 0–1 000 000.
  Effects: concurrency → `executions.setMaxConcurrent(effective)` right away; timezone/timeout/$env/vars → next execution
  via `runtime()`; timezone change also re-activates active workflows so schedules use it. Save-data policies: in
  `ExecutionService.applySaveSettings` the workflow's own setting wins, else the instance default (production runs);
  manual `none` is handled by the pruner (W3).
- UI: `VariablesPage.tsx` (table, inline add/edit/delete with confirm, copy `{{ $vars.key }}`, empty state explains
  `$vars`); `SettingsPage.tsx` sections: General (timezone select with search + "Use .env value"), Executions (timeout,
  concurrency, save data success/error/manual), Data retention (days, max count, "Prune now" → `POST /api/executions/prune`),
  Security ($env access tri-state, Execute Command toggle as today). Show the effective value next to each "default".
- Tests: `server/tests/variables.test.ts` (CRUD + bad input, `$vars` in an expression AND in the Code node, both run
  modes), extend `server/tests/settings.test.ts` (validation, effective values, concurrency applied, timezone in `$now`,
  `$env` toggle, save-data defaults).

## W5 — Templates + Dashboard
- `GET /api/templates?q=&category=` → `TemplateInfo[]`: every `examples/*.json` (`source: 'example'`) + every template
  in `server/src/ai/builder/templates.ts` (`source: 'template'`) + at least 6 new templates in `templates/*.json`
  (root folder, same format as `examples/`, `meta.description`, `meta.categories`). Categories derived from
  `meta.categories` or node types. Each new template must pass `WorkflowBodySchema` and use only registered node types.
- `GET /api/templates/:id` → `TemplateDetail`; `POST /api/templates/:id/import` → 201 `WorkflowRecord` (fresh
  `webhookId`s, unique name, version `source: 'import'`). Unknown id → 404.
- `GET /api/dashboard` → `DashboardStats` (SQL aggregates on `executions`; days in the effective timezone; recent = 10;
  topFailing = 5 over 14 days; integrations from the credential types registry + `credentials.list()` + env fallback
  check without exposing values).
- UI `TemplatesPage.tsx`: search, category chips, cards with node icons, graph preview (small inline SVG drawn from
  positions + connections, no React Flow), "Use template" → import → open editor. `DashboardPage.tsx` at `/home`
  (title stays "Overview"): KPI tiles (executions 14 d, success rate, avg duration, active workflows), stacked bar chart
  runs per day (recharts 3.x — engines `>=18`, fine for Node 20), top failing list, recent executions (→ detail), integrations
  health (credential types: configured / from .env / missing → link to Credentials). Keep the current Overview cards
  (`server-status`, `ws-status`, `public-url` test ids are used by `web/e2e/phase0-auth-shell.spec.ts`), then delete
  `OverviewPage.tsx` and `PlaceholderPage.tsx` if unused.
- Tests: `server/tests/templates.test.ts` (list, filter, every template imports and validates, 404), `server/tests/dashboard.test.ts`
  (zero days filled, success rate, top failing, no secret in the response).

## Security checks (orchestrator verifies)
- Exports, versions and execution data contain credential references `{id, name}` only, never secret values.
- Every new route returns 401 without a session.
- Pruning never deletes queued/running/waiting executions.
- `$vars` works in expressions and in the Code node.
