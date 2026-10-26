import type {
  BinaryRef,
  ConnectionSpec,
  CredentialValue,
  ExecutionMode,
  Item,
  JsonObject,
  NodeDescription,
  NodeProperty,
  WorkflowData,
  WorkflowNode,
} from '@flowforge/shared';
import type { Logger } from '../logger.js';

/** HTTP response sent back to the caller of a webhook (Respond to Webhook node, response modes). */
export interface WebhookResponse {
  statusCode: number;
  headers?: Record<string, string>;
  /** Object → JSON, string → text, Buffer → raw bytes, undefined → empty body. */
  body?: unknown;
  redirect?: string;
}

export interface SubWorkflowRequest {
  /** Workflow stored in the database… */
  workflowId?: string;
  /** …or given inline as JSON. */
  workflow?: WorkflowData;
  items: Item[];
  wait: boolean;
}

/** Credential values handed to a node (in memory only: never stored in execution data). */
export interface ResolvedCredential {
  data: Record<string, CredentialValue>;
  /** "credential" = saved on the Credentials page, "env" = read from .env. */
  source: 'credential' | 'env';
  id?: string;
  name?: string;
}

export interface CredentialsProvider {
  /** Node-selected credential → default of the type → .env → MissingCredentialError. */
  resolve(node: WorkflowNode, type: string): ResolvedCredential;
}

export interface NodeHelpers {
  /** Stores a file for this execution and returns the reference to put in `item.binary`. */
  prepareBinaryData(data: Buffer, fileName?: string, mimeType?: string): Promise<BinaryRef>;
  /** Reads the bytes of `item.binary[property]` of the given input item. */
  getBinaryDataBuffer(itemIndex: number, property?: string): Promise<Buffer>;
  /** Turns plain objects (or an array of them) into items. */
  returnJsonArray(data: JsonObject | JsonObject[]): Item[];
}

export interface ExecuteContext {
  readonly node: WorkflowNode;
  readonly workflow: WorkflowData;
  readonly mode: ExecutionMode;
  readonly executionId: string;
  readonly runIndex: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly helpers: NodeHelpers;

  getInputData(inputIndex?: number): Item[];
  /** Number of main inputs this node has. */
  getInputCount(): number;
  /** Parameter value for the given item: defaults applied and `={{ }}` expressions resolved. */
  getNodeParameter<T = unknown>(name: string, itemIndex: number, fallback?: T): T;
  /** Raw stored parameter (no expression resolution). */
  getRawParameter(name: string): unknown;
  /**
   * Evaluates an expression string ("={{ … }}") for an item. `extra` adds values such as `$response`
   * and `$pageCount` (HTTP Request pagination).
   */
  evaluateExpression(expression: string, itemIndex: number, extra?: Record<string, unknown>): unknown;
  /** True when the node is set to continue (regular output or error output) after a failure. */
  continueOnFail(): boolean;
  /**
   * Runs `fn` for every item of input 0 and collects the results.
   * Per-item failures follow the node's "On Error" setting (stop / continue / error output).
   */
  forEachItem(fn: (item: Item, itemIndex: number) => Promise<Item | Item[] | null | undefined> | Item | Item[] | null | undefined): Promise<Item[]>;
  /** State that survives between runs of this node inside one execution (Loop Over Items). */
  getNodeState<T extends object>(): T;
  /** Output items (output 0, last run) of an already executed node, or undefined. */
  getNodeOutput(nodeName: string): Item[] | undefined;
  /** Resolves the paired item of `nodeName` for input item `itemIndex` (like `$('Node').item`). */
  getPairedItem(nodeName: string, itemIndex: number): Item;
  getTimezone(): string;
  /** Adds a line to the node's log (shown with the output). */
  addLog(line: string): void;
  /** Pauses the execution (Wait node). Never returns. */
  putExecutionToWait(resumeAt: Date | null, kind: 'time' | 'webhook' | 'form'): never;
  /** Sends the HTTP response of a webhook execution. Returns false when there is no caller waiting. */
  sendWebhookResponse(response: WebhookResponse): boolean;
  /** Runs another workflow and returns the output of its last node (or the input when not waiting). */
  executeWorkflow(request: SubWorkflowRequest): Promise<Item[]>;
  /** URLs that resume this execution when it waits for a webhook call or a form. */
  getResumeUrls(): { webhook: string; form: string };
  /** Credentials of a type declared in the node description. Throws MissingCredentialError. */
  getCredentials(type: string): Promise<ResolvedCredential>;
  /** Folder the file nodes may read and write (./data/files by default). */
  getFilesRoot(): string;
  /** An instance setting switched on the Settings page (e.g. "executeCommandEnabled"). */
  getInstanceSetting(key: string): unknown;
  /** Global variables of this run (`$vars`). */
  getVariables(): Record<string, string>;
  /** Visible environment variables (`$env`), or null when $env access is switched off. Secret-looking names are always hidden. */
  getEnv(): Record<string, string> | null;
  /** Conversation history of a chat session of this workflow (Chat Trigger → AI nodes). */
  getChatMemory(sessionId: string): ChatMemory;
  /**
   * Sub-nodes attached to the AI slots of this node (cluster nodes). Their parameters are resolved for input item
   * `itemIndex` of THIS node; every call through the returned objects is recorded as a run of the sub-node.
   */
  getAiChatModel(itemIndex?: number): Promise<AiChatModel | undefined>;
  getAiMemory(itemIndex?: number): Promise<AiMemory | undefined>;
  getAiTools(itemIndex?: number): Promise<AiTool[]>;
}

// ── AI cluster nodes (AI Agent + sub-nodes) ──────────────────────────────────

export type AiConnectionType = 'ai_languageModel' | 'ai_memory' | 'ai_tool';

/** JSON Schema of a tool's arguments (always an object). */
export interface ToolParameters {
  type: 'object';
  properties: Record<string, JsonObject>;
  required?: string[];
}

/** What a Tool sub-node supplies. */
export interface AiTool {
  /** Function name given to the model: letters, digits and underscores, at most 64 characters. */
  name: string;
  /** Tells the model when to use the tool. */
  description: string;
  parameters: ToolParameters;
  /** Runs the tool with the arguments chosen by the model. Returns anything JSON-serializable; may throw. */
  invoke(args: JsonObject, o: { signal: AbortSignal }): Promise<unknown>;
}

export interface LlmToolCall {
  /** Identifier given by the provider (sent back with the result when present). */
  id?: string;
  name: string;
  args: JsonObject;
}

export type LlmMessage =
  | { role: 'user'; text: string }
  /** `raw` = the provider's own message object: resent unchanged (Gemini thought signatures live there). */
  | { role: 'model'; text: string; toolCalls?: LlmToolCall[]; raw?: unknown }
  | { role: 'tool'; results: { id?: string; name: string; output: unknown; isError?: boolean }[] };

export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  tools?: Pick<AiTool, 'name' | 'description' | 'parameters'>[];
  /** "none": the model must answer with text even though tools are declared. Default "auto". */
  toolChoice?: 'auto' | 'none';
}

export interface LlmTurn {
  text: string;
  toolCalls: LlmToolCall[];
  finishReason: string;
  model: string;
  usage: { promptTokens: number; outputTokens: number; totalTokens: number };
  /** Provider message to put back in the next request as `LlmMessage.raw`. */
  raw: unknown;
}

/** What a Chat Model sub-node supplies. */
export interface AiChatModel {
  provider: string;
  model: string;
  generate(request: LlmRequest, o: { signal: AbortSignal }): Promise<LlmTurn>;
}

/** What a Memory sub-node supplies. */
export interface AiMemory {
  sessionId: string;
  /** Earlier messages of the session, oldest first. */
  load(): ChatTurn[];
  save(turns: ChatTurn[]): void;
  clear(): void;
}

export type SuppliedData = AiChatModel | AiMemory | AiTool;

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
}

export interface ChatMemory {
  /** The last `limit` messages, oldest first. */
  load(limit: number): ChatTurn[];
  append(turns: ChatTurn[]): void;
  clear(): void;
}

/** Where chat sessions are kept (SQLite table `chat_memory`; keys are scoped per workflow by the engine). */
export interface ChatMemoryStore {
  load(sessionKey: string, limit: number): ChatTurn[];
  append(sessionKey: string, turns: ChatTurn[]): void;
  clear(sessionKey: string): void;
}

/** Given to trigger nodes while their workflow is active (or listening for a test event). */
export interface TriggerContext {
  readonly node: WorkflowNode;
  readonly workflow: WorkflowData;
  /** "trigger" when active, "manual" when listening for a test event. */
  readonly mode: 'trigger' | 'manual';
  readonly logger: Logger;
  readonly timezone: string;
  /** Root folder file triggers may watch. */
  readonly filesRoot: string;
  getNodeParameter<T = unknown>(name: string, fallback?: T): T;
  /** Starts an execution with these items. */
  emit(items: Item[]): void;
  /** Reports a runtime problem (workflow stays active, status turns red). */
  emitError(error: Error): void;
  /** Data kept between polls (persisted). */
  getStaticData(): Record<string, unknown>;
  /** Writes the static data to the database now (listeners: it is otherwise saved when the trigger stops). */
  saveStaticData(): void;
  /** Credentials of a type declared in the node description. Throws MissingCredentialError. */
  getCredentials(type: string): ResolvedCredential;
}

export interface TriggerHandle {
  close(): Promise<void> | void;
}

export interface WebhookRequestData {
  method: string;
  /** Path params, e.g. { id: "42" } for "user/:id". */
  params: Record<string, string>;
  query: Record<string, unknown>;
  headers: Record<string, string>;
  body: unknown;
  contentType: string;
  rawBody: Buffer;
  files: Array<{ field: string; fileName: string; mimeType: string; data: Buffer }>;
  /** Full URL that was called. */
  webhookUrl: string;
  /** Path of the request as the caller sent it (e.g. "/form-test/abc"): use it for links back to the same URL. */
  requestPath: string;
  executionMode: 'test' | 'production';
}

export type WebhookResponseMode = 'onReceived' | 'lastNode' | 'responseNode';

export type WebhookHandleResult =
  /** Answer right away without running the workflow (e.g. failed authentication). */
  | { response: WebhookResponse }
  | {
      items: Item[];
      responseMode: WebhookResponseMode;
      responseCode?: number;
      responseHeaders?: Record<string, string>;
      /** onReceived: custom body (default {"message":"Workflow was started"}). */
      onReceivedBody?: unknown;
      /** lastNode: what to send back. */
      lastNodeData?: 'firstEntryJson' | 'allEntries' | 'firstEntryBinary' | 'noData';
      binaryProperty?: string;
      /**
       * Custom answer (forms): called right away for onReceived, or when the run ends for lastNode.
       * Replaces the default bodies of those response modes.
       */
      complete?(outcome: WebhookOutcome): WebhookResponse;
    };

/** `items` = output of the last node that ran (empty when the run failed). */
export type WebhookOutcome = { finished: false } | { finished: true; status: string; error?: string; items: Item[] };

/** First URL segment of a public endpoint: /webhook/…, /form/…, /chat/… (each has its own path namespace). */
export type UrlPrefix = 'webhook' | 'form' | 'chat';

/** Nodes that receive HTTP requests (Webhook, Form Trigger, Chat Trigger). */
export interface WebhookSpec {
  /** "/webhook/…", "/form/…" or "/chat/…" style URLs. */
  urlPrefix: UrlPrefix;
  /** HTTP methods and path (may contain :params) for this node instance. */
  endpoints(node: WorkflowNode, parameters: JsonObject): { methods: string[]; path: string };
  handle(input: {
    request: WebhookRequestData;
    parameters: JsonObject;
    node: WorkflowNode;
    storeBinary(data: Buffer, fileName?: string, mimeType?: string): Promise<BinaryRef>;
    /** Credentials declared by the node (e.g. Basic Auth of a Webhook). */
    getCredentials(type: string): ResolvedCredential;
  }): Promise<WebhookHandleResult> | WebhookHandleResult;
  /** Allowed CORS origins ("*" or comma-separated), undefined = no CORS headers. */
  cors?(parameters: JsonObject): string | undefined;
}

export interface NodeType {
  description: NodeDescription;
  properties: NodeProperty[];
  /** Nodes whose outputs depend on parameters (Switch, Filter) compute them here. */
  outputs?: (parameters: JsonObject) => ConnectionSpec[];
  execute?(ctx: ExecuteContext): Promise<Item[][]> | Item[][];
  /**
   * Demo Mode only: realistic made-up fields for one input item, used when `execute` throws MissingCredentialError.
   * The runner adds `_simulated: true`. Must never read secrets.
   */
  simulate?(ctx: ExecuteContext, item: Item, itemIndex: number): JsonObject;
  /**
   * Sub-nodes (output type ai_languageModel / ai_memory / ai_tool): return what the parent node gets.
   * `ctx` resolves parameters against the PARENT's input item `itemIndex` (so `{{ $json.sessionId }}` works).
   */
  supplyData?(ctx: ExecuteContext, itemIndex: number): Promise<SuppliedData> | SuppliedData;
  /** Schedule / listener triggers: start listening; return a handle that stops it. */
  trigger?(ctx: TriggerContext): Promise<TriggerHandle> | TriggerHandle;
  /** Checks the configuration before activation (throw to refuse with a clear message). */
  validate?(ctx: TriggerContext): void;
  /** Polling triggers: fetch and return the NEW items (dedupe with the helpers), or [] when nothing changed. */
  poll?(ctx: TriggerContext): Promise<Item[]>;
  /** Webhook-style triggers. */
  webhook?: WebhookSpec;
}

/** Identity helper giving node files full type checking. */
export function defineNode(node: NodeType): NodeType {
  return node;
}
