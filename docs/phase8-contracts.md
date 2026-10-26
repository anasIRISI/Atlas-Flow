# Phase 8 contracts — wow features + delivery

Same rules as Phase 7 (`docs/phase7-contracts.md`): everything behind login except public URLs, central error
handler, loading / empty / error states, dark design system (`web/src/components/ui`), one test file per feature.

Already wired by the orchestrator: `NodeRun.simulated?: boolean` (shared), the orange **SIMULATED** badge on node
cards (`WorkflowNodeCard.tsx`, test id `node-simulated`, reads `runData[node].at(-1).simulated`), stub components
mounted in `web/src/editor/EditorPage.tsx`: `timetravel/TimeTravelBar.tsx` (W1), `ExecutionTimeline.tsx` (W2),
`../demo/DemoOverlay.tsx` (W3). Runner option `reuseRunData` (Phase 7) already exists.

## Recorded data (what time travel replays)
- `GET /api/executions/:id` → `ExecutionDetail`: `events: ExecutionEvent[]` (`node.started` / `node.finished`, `seq`, `ts`,
  `node`, `runIndex`, `status`), `runData[node][runIndex]` (`startTime`, `executionTime`, `status`, `source[]` = which
  parent run/output fed each input, `data.main`, `error`), `status`, `waitingNode`, `workflow` (the copy that ran).
- Live WS events (`shared/src/ws.ts`): `execution.queued|started|waiting|finished`, `node.started|finished` (with
  `itemCounts`, `preview` ≤ 3 items / 2 KB), `edge.data`. Unchanged in Phase 8 except W3's optional `demo.*` (below).

## W1 — Time-travel debugger
- Pure `shared/src/timeline.ts` (exported from `shared/src/index.ts`):
  ```ts
  interface TimelineStep {
    index: number;            // 0-based
    node: string; runIndex: number;
    status: NodeRunStatus | 'waiting';
    startedAt: number; durationMs: number | null;
    /** State of every node AFTER this step: how many runs so far, status of its latest run, items out. */
    nodes: Record<string, { status: NodeRunStatus | 'waiting'; runs: number; items: number }>;
    /** Edge keys (same format as web/src/editor/graph.ts edgeKey) that carried data up to this step → item count. */
    edges: Record<string, number>;
  }
  buildTimeline(detail): TimelineStep[]          // one step per node.finished (+ a final 'waiting' step if waiting)
  stepInput(detail, step): Item[][]              // the input of that run, rebuilt from run.source → parent output
  stepOutput(detail, step): Item[][]
  ```
  Must handle: loops (several runs per node, runIndex), failed runs (error step is the last), waiting executions,
  events whose node is missing from runData (skip), AI sub-node runs (no main source: input = []).
  Unit tests `shared/tests/timeline.test.ts` (linear, branch, loop, failed, waiting).
- UI: entry points "Time travel" button on `ExecutionDetailPage.tsx` and in the editor execution log → opens
  `/workflow/:id?execution=<id>&replay=1` (or a read-only canvas of the stored `workflow` when the workflow was deleted
  or changed). `TimeTravelBar.tsx`: prev / next / play-pause / speed, a scrubber with one tick per step coloured by status,
  "Step k / n · node · duration", keyboard ←/→/space. At step k the canvas shows only what had run (node statuses,
  edge counts) by writing into the editor store's `execution` + `runData` (no new store fields needed; leaving replay
  restores the last run with `editor.finishFromDetail`). Side panel (inside the bar or a right drawer) shows that step's
  INPUT / OUTPUT with `ndv/DataView.tsx` and the duration / error.
- "Re-run from here": `POST /api/executions/run` gains `rerunFrom?: string` (+ `previousExecutionId`): the server reuses
  the previous run data of every node that is NOT `rerunFrom` or downstream of it (`reuseRunData: true`, same
  mechanism as retry in `api/executions.ts`) and runs the rest; 400 if the node does not exist. Time travel never
  writes to the stored execution (replay is client-side; re-run creates a new execution).
- Tests: `shared/tests/timeline.test.ts`, API test for `rerunFrom` in `server/tests/executions-api.test.ts` (or a new
  `timetravel.test.ts`). E2E: `web/e2e/product-timetravel.spec.ts` — step through a finished execution.

## W2 — Live visualization polish
- Files: `editor/canvas/WorkflowNodeCard.tsx`, `FlowEdge.tsx`, `Canvas.tsx`, `index.css` (keyframes), `ExecutionTimeline.tsx`,
  `editor/hooks.ts` (live events), toasts via `lib/toast.ts`. Keep every existing `data-testid`.
- Running node: smooth glow + pulse (CSS only, `transform`/`opacity`, no layout thrash). Particles on edges scaled by item
  count (1 → 1 particle, max 8), only while data flows, CSS/SVG animation (`<animateMotion>` or offset-path), removed after.
  Edge item count label. Hover a finished node or edge → preview bubble (≤ 3 items / 2 KB, from `runData` or WS preview).
  Success: green check pop animation; error: red shake once. Respect `prefers-reduced-motion`.
- `ExecutionTimeline.tsx`: thin bar above the execution log, one segment per node run (width ∝ duration, colour = status),
  hover → node name + duration, click → open the node. Hidden when there is no run. Hidden while time travel is active
  (`?replay=1`).
- Toasts: run finished (success / failed with the node name), activation errors (already exist: keep them non-duplicated).
- Performance: subscribe with narrow zustand selectors (no whole-store reads in node cards), memoised components,
  particles capped globally (e.g. ≤ 60 at once). Manual check (not a Playwright test): 50-node workflow, 20 runs, no
  visible lag, heap stable (Chrome performance / `performance.memory`), report numbers. Unit tests for pure helpers
  (`particleCount(items)`, preview truncation) in `web/tests/`.

## W3 — Demo Mode
- Server `server/src/demo/` + `POST /api/demo/*` (login required):
  - `POST /api/demo/build { prompt? }` → `{ workflow, source: 'gemini' | 'offline' | 'showcase', label, warnings }`:
    runs the AI builder with the demo prompt ("When someone fills in a form with their email and city, get the
    weather for that city, email it to them, and post it to Telegram and Discord"); if the result has no Form Trigger
    or misses one of email / Telegram / Discord / weather, it uses the built-in **showcase template**
    (`server/src/demo/showcase.ts`: Form Trigger (Name, Email, City) → Open-Meteo → Set summary → Send Email + Telegram +
    Discord, integration nodes with `onError: continueRegularOutput`). The created workflow is saved, named
    "Demo · <time>", tagged `demo`.
  - Demo executions carry `demo: true`: `StartOptions.demo` → `RunRequest.demo` → when a node throws
    `MissingCredentialError` **and** `req.demo === true`, the runner records `status: 'success'`, `simulated: true`
    and output = input items with `json: { ...json, _simulated: true, ...node simulation }`. Nodes may export
    `simulate(ctx, item)` for realistic fields (email: `{ accepted: [to], messageId: 'simulated' }`, Telegram:
    `{ message_id: 0, chat: … }`, Discord: `{ id: 'simulated' }`, Open-Meteo / Gemini: plausible data); otherwise only
    `_simulated: true`. **Any other error stays an error.** `demo` is never read from the workflow JSON or the normal
    `/api/executions/run` / webhook / form bodies: only the demo routes can set it (test listener registered by
    `POST /api/demo/listen` → `TestListeners.listen(..., { demo: true })` → webhook-service passes it to `start()`).
  - `POST /api/demo/listen { workflowId }` → `{ formUrl, testUrl, expiresAt }` (form test URL, 5 min);
    `POST /api/demo/simulate-submission { workflowId }` → submits sample answers to that same test URL server-side
    (a real HTTP form submission, labelled in the UI "Simulating a submission"); returns `{ executionId }`.
  - Optional WS `demo.step` events are not required: the client drives the script.
- Client `web/src/demo/`: "Demo Mode" button in the sidebar (and the Overview header). Script (`demo-script.ts`, pure
  state machine, unit-tested in `web/tests/demo-script.test.ts`):
  1. Build: call `/api/demo/build`, open the editor with `?demo=1`, draw it with the existing builder animation
     (`editor/builder.ts` `drawWorkflow`); toast "Built with Gemini" / "Offline: closest template" / "Showcase workflow".
  2. QR: open the QR dialog (`components/QrDialog.tsx`) of the form test URL; narration "Scan with your phone".
  3. Wait: listen; if no submission after 20 s, call `simulate-submission` with toast "Simulating a submission".
  4. Run: the live animation shows the run (WS, existing live view).
  5. Results card: one line per integration: ✓ sent / ⚠ simulated (no key) / ✗ failed (reason), from the execution detail.
  Controls always visible in `DemoOverlay.tsx`: step k / 5, narration text, **Skip step**, **Stop demo**. Every step has a
  timeout + fallback (build fails → showcase; listen fails → simulate directly; run fails → results show the error). Demo
  state lives in a client store; leaving the editor stops the demo.
- Tests: `server/tests/demo.test.ts` (no keys → simulated items + `simulated: true` ONLY for demo runs; the same
  workflow run normally → MissingCredentialError; Gemini down → showcase/offline; simulate-submission starts a run;
  routes need login; no secret in demo responses). E2E: `web/e2e/product-demo.spec.ts` — Demo Mode end to end with no
  keys (fallbacks, SIMULATED badges, results card).

## W4 — Examples + docs
- 8 planned examples in `examples/` (existing 7 count; add what is missing): weather email ✓, contact form ✓, Telegram
  assistant ✓, website chatbot ✓, **REST API webhook** (Webhook → Switch/IF → Respond to Webhook with different status
  codes), **RSS → Discord digest**, **CSV pipeline** (Read/convert CSV → transform → summarize → file), **resilience demo**
  (retry on fail, continue on fail, error output, Error Trigger workflow, sub-workflow). Multi-workflow examples use one file
  with `workflows: [...]` (+ `meta`), imported together by `/api/examples/:id/import` with cross references rewritten
  (`settings.errorWorkflow`, Execute Workflow `workflowId`); keep the single-workflow format working.
- Each new example runs end to end against the mocks in `server/tests/examples.test.ts`.
- `README.md`: install, run, features, architecture diagram (Mermaid), screenshot placeholders (`docs/screenshots/*.png`
  paths), phone access (LAN + firewall commands), Cloudflare tunnel fallback, troubleshooting, and **Teacher demo script**:
  exact 5-minute click sequence, what to say at each step, what to do if a step fails. Keep facts true to the code
  (menu labels, test ids are not user-facing).
