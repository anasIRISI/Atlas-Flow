# Phase 6 contracts: AI Agent (cluster nodes) and AI Workflow Builder

Gemini function calling was checked in the official reference on 2026-10-12
(<https://ai.google.dev/api/generate-content>, <https://ai.google.dev/api/caching>,
<https://ai.google.dev/gemini-api/docs/thinking>). **Do not use a field that is not listed here.**

## Common rules (all workers)

- Node 20.11, TypeScript strict, ESM with `.js` imports. No new dependency (`mathjs` and `@dagrejs/dagre` are
  already installed in `server/`).
- A node = ONE file `server/src/nodes/ai/<name>.node.ts`, `export default defineNode({...})`, auto-registered.
- Tests use ONLY a local mock (`server/tests/gemini-mock.ts`, `open-meteo-mock.ts`, `http-mock.ts`). No real network.
- Secrets (API keys, credential values) never appear in prompts, tool results, outputs, error messages or logs.
- Other workers edit the repo at the same time: touch only your files, do not edit shared engine code, do not run the
  full suite. Run `cd server && npx vitest run tests/<your file>` and, at the end, `npx tsc --noEmit -p .` (fix only
  YOUR errors). Do not commit. Report in 5 lines: files, tests passing, open issues / deviations.

Patterns to read (nothing else unless your section names it):

| What | File |
|---|---|
| Node file with credentials, `forEachItem`, errors | `server/src/nodes/integrations/google-gemini.node.ts` |
| Gemini client (HTTP, error translation, retries) | `server/src/integrations/gemini.ts`, `errors.ts` |
| Engine types (AI section at the end of `ExecuteContext`) | `server/src/engine/types.ts` |
| How sub-nodes are supplied / recorded (already built) | `server/src/engine/runner.ts` → `supply()`, `recorded()` |
| Test nodes `test.aiHarness`, `test.fakeTool` + `run(wf(...))` | `server/tests/engine-helpers.ts`, `server/tests/ai-engine.test.ts` |
| App-level tests (credential + `/api/dev/run`) | `server/tests/gemini.test.ts` (first 70 lines), `server/tests/chat.test.ts` (last block) |
| Node registry (descriptions, `list()`, `outputsFor`) | `server/src/nodes/registry.ts` |

## Cluster nodes (built by the orchestrator, do not change)

- Connection types: `main`, `ai_languageModel`, `ai_memory`, `ai_tool`. A **sub-node** has `inputs: []`,
  `outputs: [{ type: 'ai_tool' }]` (or the two others), `group: 'ai-sub'`, and **no `execute`**: it implements
  `supplyData(ctx, itemIndex)`.
- Workflow JSON (n8n style): the connection goes FROM the sub-node TO its parent:
  `connections["Weather Tool"] = { ai_tool: [[{ node: "AI Agent", type: "ai_tool", index: 0 }]] }`.
- The parent declares its slots in `description.inputs`:
  `[{ type: 'main' }, { type: 'ai_languageModel', displayName: 'Chat Model', required: true, maxConnections: 1 },
  { type: 'ai_memory', displayName: 'Memory', maxConnections: 1 }, { type: 'ai_tool', displayName: 'Tool' }]`.
- The parent calls `await ctx.getAiChatModel(i)`, `ctx.getAiMemory(i)`, `ctx.getAiTools(i)`. The engine calls each
  attached sub-node's `supplyData(ctx, i)` where `ctx.getNodeParameter(name, i)` resolves expressions against the
  PARENT's input item `i` (so `{{ $json.sessionId }}` works in a sub-node), then wraps the result so that every
  `generate` / `load` / `save` / `invoke` is recorded as a run of the sub-node. Disabled sub-nodes are skipped.
- Interfaces (`engine/types.ts`): `AiTool { name, description, parameters (JSON Schema object), invoke(args, { signal }) }`,
  `AiMemory { sessionId, load(), save(turns), clear() }` with `ChatTurn { role: 'user' | 'model', text }`,
  `AiChatModel { provider, model, generate(LlmRequest, { signal }): Promise<LlmTurn> }`,
  `LlmRequest { system?, messages: LlmMessage[], tools?, toolChoice?: 'auto' | 'none' }`,
  `LlmMessage` = `{ role: 'user', text }` | `{ role: 'model', text, toolCalls?, raw? }` |
  `{ role: 'tool', results: [{ id?, name, output, isError? }] }`,
  `LlmTurn { text, toolCalls: [{ id?, name, args }], finishReason, model, usage, raw }`.

---

## W1 Agent core

Files: `server/src/integrations/gemini.ts` (ADD `generateTurn`, do not change `generateContent`),
`server/src/nodes/ai/ai-agent.node.ts`, `gemini-chat-model.node.ts`, `simple-memory.node.ts`,
`server/tests/ai-agent.test.ts`. You may ADD helpers to `server/tests/gemini-mock.ts` (e.g. `functionCall(name, args)`)
without changing the existing exports.

**Gemini function calling (generateContent)**

- Request adds `tools: [{ functionDeclarations: [{ name, description, parametersJsonSchema }] }]`
  (`name`: a-z, A-Z, 0-9, `_`, max 128; `parametersJsonSchema` = a JSON Schema object) and optionally
  `toolConfig: { functionCallingConfig: { mode: 'NONE' } }` (the model must answer with text; default mode AUTO:
  do not send `toolConfig` then).
- Answer: `candidates[0].content = { role: 'model', parts: [...] }` where a part is `{ text }` or
  `{ functionCall: { id?, name, args } }`, and any part may carry `thought: true` and/or `thoughtSignature`
  (opaque base64). Several `functionCall` parts = parallel calls.
- **Thought signatures:** the model content must be sent back EXACTLY as received (all parts, including
  `thoughtSignature` and thought parts). So `LlmTurn.raw` = `candidates[0].content` untouched, and a model
  `LlmMessage` with `raw` is put in `contents` as is. Never rebuild it from `text` / `toolCalls` when `raw` exists.
- Tool results: one content `{ role: 'user', parts: [{ functionResponse: { id?, name, response } }, …] }` in the same
  order as the calls. `response` must be a JSON object: wrap other values as `{ result: value }`; a failed call is
  `{ error: "message" }`. `id` is copied from the call when it had one.
- `finishReason` may also be `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`,
  `MISSING_THOUGHT_SIGNATURE`: no text and no function call with one of these ⇒ `IntegrationError`
  ("Gemini could not call the tool (MALFORMED_FUNCTION_CALL)" + a hint).

**`generateTurn(auth, { model, contents, systemInstruction?, tools?, toolChoice?, temperature?, maxOutputTokens?,
topP?, topK?, maxRetries? }, o)`** in `gemini.ts`: same URL, header, retries (429 / 500 / 503) and error translation as
`generateContent` (share the code, do not copy it), returns `{ content (raw), text, functionCalls, finishReason, model,
usage }`. A turn with function calls and no text is valid (not an "empty answer" error).

**Gemini Chat Model** `flowforge.geminiChatModel` ("Gemini Chat Model", icon `lucide:sparkles`, group `ai-sub`,
`outputs: [{ type: 'ai_languageModel' }]`, credentials `googlePalmApi`): `model` (same options as the Google Gemini
node) + `customModel`, `options` (temperature, maxOutputTokens, topP, topK, maxRetries, timeout). `supplyData` resolves
the credential (missing ⇒ the usual `MissingCredentialError`) and returns an `AiChatModel` that maps `LlmRequest` ⇄
Gemini as described above. Errors go through `toNodeError` (wrong key ⇒ `CredentialError` with `credentialId`).

**Simple Memory** `flowforge.simpleMemory` ("Simple Memory", icon `lucide:brain`, group `ai-sub`,
`outputs: [{ type: 'ai_memory' }]`): `sessionKey` (default `={{ $json.sessionId }}`), `contextWindow` (number, default
10, 1–100). Uses `ctx.getChatMemory(sessionKey)` (table `chat_memory`, already scoped per workflow). `load()` returns
the last N messages and drops leading `model` messages so the history starts with a user message.

**AI Agent** `flowforge.aiAgent` ("AI Agent", icon `lucide:bot`, group `ai`, inputs as in "Cluster nodes", one main
output): `prompt` (string, default `={{ $json.chatInput }}`, required), `systemMessage` (default
`You are a helpful assistant.`), `options`: `maxIterations` (default 8, clamped 1–8), `toolTimeout` (seconds, default 30).

Loop, per input item (`ctx.forEachItem`):

1. No chat model ⇒ `NodeOperationError('No Chat Model is connected to the AI Agent', hint: 'Attach a Gemini Chat
   Model to the "Chat Model" slot under the agent.')`. Empty prompt ⇒ clear error. Two tools with the same name ⇒
   clear error naming both nodes' tool name.
2. `messages = memory?.load()` (as user / model text messages) + `{ role: 'user', text: prompt }`.
3. Repeat at most `maxIterations` times (one iteration = one model call): `turn = model.generate({ system, messages,
   tools, toolChoice })`. On the LAST allowed iteration pass `toolChoice: 'none'` so the model must answer.
   - no tool calls ⇒ `turn.text` is the answer, stop.
   - else push `{ role: 'model', text, toolCalls, raw }`, run every call **in order**, push one
     `{ role: 'tool', results }` message, continue.
4. A tool call never crashes the agent: unknown tool name ⇒ result `{ isError, output: 'Unknown tool "x". Available
   tools: a, b' }`; a tool that throws or exceeds `toolTimeout` ⇒ `{ isError, output: <message> }`; the model then
   decides. Results larger than 20 000 characters (JSON) are cut with a note. Only an abort of the execution
   (`ctx.signal`) stops everything.
5. The loop cannot run forever: bounded by `maxIterations` ≤ 8, the model timeout, `toolTimeout` and `ctx.signal`.
   If the last iteration still gives no text ⇒ `NodeOperationError('The agent did not reach an answer in N steps')`.
6. Success ⇒ `memory?.save([{ role: 'user', text: prompt }, { role: 'model', text: answer }])` and output
   `{ output, iterations, toolCalls: [{ tool, input, output | error }], model, usage (summed), stoppedAtLimit }`.
   Nothing is saved to memory when the agent fails.

**Tests** (`ai-agent.test.ts`, mock Gemini; use `test.fakeTool` and/or a Weather Tool stand-in you define in the test
if W2's node is not there yet): plain answer without tools; **weather question answered through a tool** (mock answers
turn 1 with a `functionCall`, turn 2 with text; assert the second request contains the model content unchanged incl. a
`thoughtSignature`, then the `functionResponse` with the tool output); two parallel calls; unknown tool ⇒ error result
goes back to the model; failing tool ⇒ `{ error }` goes back and the agent still answers; **memory keeps context
between 2 messages** (second request contains the first exchange; sessions are separate); **max-iterations stop**
(mock always answers with a function call: exactly N model calls, last one has `mode: 'NONE'`, clear error, nothing
saved); no model attached; missing credential on the model sub-node (error on that sub-node, `credentialType`);
400 invalid key; 429 then success; timeout; sub-node runs recorded in `runData` (model, memory, tool); the API key
never in the run result or captured logs; system message sent as `systemInstruction`.

---

## W2 Tools

Files: `server/src/nodes/ai/http-request-tool.node.ts`, `code-tool.node.ts`, `calculator-tool.node.ts`,
`weather-tool.node.ts`, `server/tests/ai-tools.test.ts`. Extra patterns: `server/src/nodes/_shared/http-client.ts`
(`httpSend`, `redact`, `HTTP_AUTH_PROPERTY`, `HTTP_AUTH_CREDENTIALS`, `resolveHttpAuth`), `server/src/nodes/transform/code.node.ts`
+ `server/src/engine/code/sandbox.ts` (QuickJS), `server/src/integrations/open-meteo.ts` (`geocode`, `forecast`,
`toWeatherOutput`), `server/tests/open-meteo-mock.ts`, `server/tests/http-mock.ts`.

Every tool is a sub-node: `group: 'ai-sub'`, `inputs: []`, `outputs: [{ type: 'ai_tool' }]`, no `execute`,
`supplyData(ctx, i)` returns an `AiTool`. Common parameters: `toolName` (default given below; must match
`^[A-Za-z_][A-Za-z0-9_]{0,63}$`, else a clear error) and `toolDescription` (default given below, what the model
reads). `invoke` returns a small JSON-serializable value and throws a clear `Error` / `NodeOperationError` on
failure (the agent reports it to the model). Test them through the engine with `test.aiHarness`
(`{ tool: '<name>', args: {...} }`): see `ai-engine.test.ts`.

- **Calculator** `flowforge.calculatorTool` (icon `lucide:calculator`, name `calculator`): schema
  `{ expression: string }` (required). Evaluates with **mathjs** following
  <https://mathjs.org/docs/expressions/security.html>: a private `create(all)` instance whose `import`, `createUnit`,
  `evaluate`, `parse`, `simplify`, `derivative`, `resolve`, `reviver` are overridden to throw; expression ≤ 1000
  characters; run inside `vm.runInNewContext('fn()', { fn }, { timeout: 1000 })` so a runaway expression is stopped.
  Returns `{ expression, result }` where `result` is a number or a string (`math.format(value, { precision: 14 })`).
  Errors: empty expression, syntax error (the mathjs message), blocked function, timeout.
- **Weather Tool** `flowforge.weatherTool` (icon `lucide:cloud-sun`, name `get_weather`): schema `{ city: string
  (required), days: integer 1–7 (optional, default 3) }`. Node parameters: `temperatureUnit`, `windSpeedUnit`
  (same values as the Weather node), `options.forecastUrl`, `options.geocodingUrl` (tests), `options.timeout`.
  Reuses the Open-Meteo client. Returns `{ location: 'Paris, France', summary, current: { temperature, feelsLike,
  description, windSpeed, humidity }, daily: [{ date, description, temperatureMin, temperatureMax,
  precipitationProbability }], units, attribution }`. Unknown city ⇒ throws `No place found for "x"`.
- **HTTP Request Tool** `flowforge.httpRequestTool` (icon `lucide:globe`, name `http_request`): parameters `method`
  (GET default, POST, PUT, PATCH, DELETE), `url` (may contain `{placeholders}`), `toolParameters` fixedCollection
  (multiple `parameter`: `name`, `description`, `type` string | number | boolean, `required`), `sendIn`
  (`query` default | `body` JSON) for parameters that are not placeholders, `authentication` + credentials exactly
  like the HTTP Request node, `options`: `timeout` (seconds, 15), `maxResponseChars` (4000), `headers` (keyValue or
  fixedCollection, static). Schema = the declared parameters. **The model can only fill placeholders and declared
  parameters**: a placeholder inside the scheme / host / port part of the URL is refused at supply time (the model must
  never choose the server), placeholder values are `encodeURIComponent`-ed, undeclared arguments are ignored.
  Returns `{ status, body }` (JSON parsed when possible, text cut at `maxResponseChars` with a note); a 4xx / 5xx
  throws with the status and the start of the body; every text goes through `redact(text, secrets)`.
- **Code Tool** `flowforge.codeTool` (icon `lucide:code`, name `run_code`): parameters `toolParameters` (same
  fixedCollection as above) and `jsCode` (default: a small example using `input`). The code runs in the existing
  QuickJS sandbox with the arguments as the object `input` (and `query` = the first string argument) and must
  `return` a JSON-serializable value. Same time / memory limits and error translation as the Code node. No access to
  items, credentials, network or files.

**Tests** (`ai-tools.test.ts`): for each tool the golden call + schema + name/description overrides + invalid tool
name; calculator: arithmetic, functions (`sqrt`, `sin`), units (`5 cm to inch`), big numbers, syntax error, blocked
`import` / `evaluate`, too long, timeout; weather: city, days, units, unknown city, API down; HTTP: placeholder in
path + query parameters, body mode, credential used (secret never in the result or in an error), placeholder in the
host refused, undeclared argument ignored, 404, timeout, long response cut; code: uses `input`, returns objects, syntax
error, runtime error, infinite loop stopped, no `process` / `require`.

---

## W3 Builder backend

Files: `server/src/ai/builder/*.ts` (`catalog.ts`, `prompt.ts`, `validate.ts`, `layout.ts`, `fallback.ts`,
`templates.ts`, `index.ts`), `server/src/api/ai.ts` (stub exists and is already mounted at `/api/ai`),
`server/tests/ai-builder.test.ts`. Response type: `BuildWorkflowResponse` in `shared/src/ai.ts` (do not change it).
Extra patterns: `server/src/api/examples.ts` (`EXAMPLES_DIR`, reading examples), `server/src/credentials/check.ts`
(`activeCredentialTypes`), `server/src/engine/params.ts` (`withDefaults`), `server/src/api/schemas.ts`,
`web/src/editor/graph.ts` (the editor's dagre layout, for the same look), `examples/*.json`.

`POST /api/ai/build-workflow { prompt }` (login required, prompt 3–2000 characters, else 400) ⇒ `BuildWorkflowResponse`.
It ALWAYS answers 200 with a valid workflow (AI or offline fallback); only a bad request is an error.

Pipeline (`buildWorkflow(prompt, deps)` with injectable `registry`, `credentials`, `examplesDir`, `logger`):

1. **Catalog** from the registry: every non-hidden node except `flowforge.stickyNote`: `type`, `name`, `description`,
   `group`, `trigger` kind, main input / output counts and output labels, AI slots (`inputs` of type `ai_*`) or the
   AI output type of a sub-node, credentials, and its parameters in a compact form (`name`, `type`, option values,
   `required`, default when short; nested collections one level deep). Keep the whole catalog under ~12 000 characters.
2. **Prompt**: system instruction = rules + catalog + one short example; user text = the request. Ask for JSON only
   (`generateContent(..., { json: true, temperature: 0.2, maxRetries: 1 })`, timeout 45 s) with this shape:
   `{ "name": string, "nodes": [{ "name": string, "type": string, "parameters": object }], "connections": [{ "from":
   string, "to": string, "fromOutput"?: number, "toInput"?: number, "type"?: "main" | "ai_languageModel" | "ai_memory" |
   "ai_tool" }], "notes"?: string[] }`. Expressions use `={{ $json.field }}`. Sub-nodes connect FROM the sub-node TO the
   agent. The credential is resolved with `credentials.resolve({ name: 'AI Workflow Builder' } as WorkflowNode,
   'googlePalmApi')`; its `model` is used. **The prompt contains the catalog and the user's text only: no credential
   value, no `.env` value, no existing workflow.**
3. **Validate** (`validate.ts`, pure, returns `{ workflow?, errors: string[] }`): JSON shape (zod); 1–30 nodes; unique
   non-empty names; every `type` exists in the catalog (repair obvious variants first: missing `flowforge.` prefix,
   `n8n-nodes-base.x`, case, display name; otherwise an error naming the type and the closest valid types); parameters
   are an object, unknown parameter names are dropped, option values must be allowed, required parameters must not be
   empty; connections: both nodes exist, `fromOutput` < number of outputs of the source (use `registry.outputsFor`),
   `toInput` < number of main inputs, no connection into a trigger, no self-loop, AI connections only from a sub-node
   to a node that has that slot, `maxConnections` respected, every `required` slot filled, every sub-node attached;
   at least one trigger; every non-trigger node reachable from a trigger (or attached as a sub-node); no cycle unless
   it goes through Loop Over Items. The result is converted to FlowForge JSON (ids, `typeVersion: 1`, connections in
   n8n format, `webhookId` for webhook-kind triggers).
4. **One retry**: when there are errors, call Gemini once more with the previous answer and the numbered error list.
   Still invalid ⇒ offline fallback (reason: "Gemini's answer was not a valid workflow"). Non-JSON answers count as
   invalid. **The response can never contain a node type that is not in the registry.**
5. **Layout** (`layout.ts`, `@dagrejs/dagre`, left to right, same spacing as the editor's auto-layout): main graph by
   dagre, sub-nodes in a row under their parent. Positions are integers; no two nodes overlap.
6. **Offline fallback** (`fallback.ts`): templates = every file in `examples/` (name, `meta.description`, node names
   and types) plus a few small built-in ones in `templates.ts` (at least: webhook → respond with JSON; schedule →
   HTTP Request → IF → Discord alert ("website down"); RSS feed → Telegram; manual → HTTP Request → Code summary).
   Score = keyword overlap with a small synonym map (mail/email/gmail, bot/telegram, chat/chatbot/assistant,
   weather/forecast/temperature, form/survey/contact, schedule/every/daily/morning, alert/notify/notification, …) +
   TF-IDF cosine over the template texts. Pick the best; `weak: true` under a threshold you choose from the test
   prompts. Used when: no Gemini credential, Gemini error (429, timeout, 5xx, blocked), invalid answer after the retry.
   `label` = `Offline: closest template` (AI: `Built with Gemini`), `reason` in plain words without any secret,
   `template` filled. The template goes through the same validation and layout (never trust a file blindly); a
   template that does not validate is skipped.
7. `missingCredentials`: for every node, each credential type that `activeCredentialTypes` requires and that
   `credentials.resolve(node, type)` cannot find. `order`: triggers first, then main-flow order, each sub-node right
   after its parent. `notes`: Gemini's notes (max 5, 200 characters each) plus one line per missing credential.

**Tests** (`ai-builder.test.ts`, mock Gemini via the credential `host`): valid answer ⇒ `source: 'ai'`, valid
FlowForge JSON that RUNS (`POST /api/dev/run` or the runner) for a simple generated workflow; **repair**: first
answer has an unknown node type + a bad output index, the retry request contains the error list, second answer is
valid; repaired type variants (`n8n-nodes-base.httpRequest`, `HTTP Request`, `httpRequest`); **unknown type after the
retry ⇒ fallback, and the response contains no unknown type**; bad JSON twice ⇒ fallback; 429 / timeout / no
credential ⇒ fallback with the right `reason`; agent cluster answer (agent + model + tool) validated, missing model ⇒
error; layout (no overlap, sub-nodes under the parent); `missingCredentials`; prompt too short / long ⇒ 400; the
request sent to Gemini contains no credential value; **10 sample prompts through the offline fallback** as a table
test printing prompt → template → score (list the bad matches in your report).
