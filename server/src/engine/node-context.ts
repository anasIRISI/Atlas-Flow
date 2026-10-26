import type { BinaryRef, ExecutionMode, Item, JsonObject, RunData, TaskSource, WorkflowData, WorkflowNode } from '@flowforge/shared';
import type { Logger } from '../logger.js';
import type { BinaryStore } from './binary-store.js';
import { CredentialError, MissingCredentialError, NodeOperationError, WaitSignal, toFlowError } from './errors.js';
import type { ExpressionEngine, ExpressionScope } from './expressions/engine.js';
import { getDefault, getPath, isNoExpression } from './params.js';
import { resolvePairedItem } from './paired-items.js';
import type {
  AiChatModel,
  AiConnectionType,
  AiMemory,
  AiTool,
  ChatMemory,
  ChatMemoryStore,
  CredentialsProvider,
  ExecuteContext,
  NodeHelpers,
  NodeType,
  ResolvedCredential,
  SubWorkflowRequest,
  SuppliedData,
  WebhookResponse,
} from './types.js';

/** Capabilities the execution service gives to nodes (absent in plain test runs). */
export interface ExecutionServices {
  /** Present when a webhook caller waits for a "Respond to Webhook" node. */
  webhookResponder?: { send(response: WebhookResponse): boolean };
  executeSubWorkflow?(request: SubWorkflowRequest): Promise<Item[]>;
  resumeUrls?: { webhook: string; form: string };
}

export interface NodeContextOptions {
  /** Demo Mode run: MissingCredentialError must reach the runner (it simulates the node) instead of being swallowed by "On Error". */
  demo?: boolean;
  node: WorkflowNode;
  type: NodeType;
  workflow: WorkflowData;
  mode: ExecutionMode;
  executionId: string;
  runIndex: number;
  inputs: Item[][];
  sources: (TaskSource | null)[];
  runData: RunData;
  nodeState: Map<string, object>;
  signal: AbortSignal;
  logger: Logger;
  expressions: ExpressionEngine;
  binaryStore: BinaryStore;
  timezone: string;
  variables: Record<string, string>;
  env: Record<string, string> | null;
  services?: ExecutionServices;
  credentials?: CredentialsProvider;
  filesRoot?: string;
  instanceSettings?: { get(key: string): unknown };
  chatMemory?: ChatMemoryStore;
  /** Given by the runner: what the sub-nodes attached to an AI slot of this node supply (already recording their runs). */
  supply?(type: AiConnectionType, itemIndex: number): Promise<SuppliedData[]>;
}

export class NodeExecutionContext implements ExecuteContext {
  readonly node: WorkflowNode;
  readonly workflow: WorkflowData;
  readonly mode: ExecutionMode;
  readonly executionId: string;
  readonly runIndex: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly helpers: NodeHelpers;
  /** Items routed to the "error" output by forEachItem (continueErrorOutput). */
  readonly errorItems: Item[] = [];
  readonly logs: string[] = [];
  private readonly scope: ExpressionScope;

  constructor(private readonly o: NodeContextOptions) {
    this.node = o.node;
    this.workflow = o.workflow;
    this.mode = o.mode;
    this.executionId = o.executionId;
    this.runIndex = o.runIndex;
    this.signal = o.signal;
    this.logger = o.logger;
    this.scope = {
      workflow: o.workflow,
      runData: o.runData,
      nodeName: o.node.name,
      inputs: o.inputs,
      sources: o.sources,
      runIndex: o.runIndex,
      mode: o.mode,
      executionId: o.executionId,
      timezone: o.timezone,
      variables: o.variables,
      env: o.env,
      resumeUrl: o.services?.resumeUrls?.webhook,
      resumeFormUrl: o.services?.resumeUrls?.form,
    };
    this.helpers = {
      prepareBinaryData: (data, fileName, mimeType): Promise<BinaryRef> => o.binaryStore.store(o.executionId, data, fileName, mimeType),
      getBinaryDataBuffer: async (itemIndex, property = 'data') => {
        const ref = this.getInputData()[itemIndex]?.binary?.[property];
        if (!ref) {
          throw new NodeOperationError(`Item ${itemIndex} has no binary property "${property}"`, {
            itemIndex,
            hint: 'Check the name of the binary field in the INPUT panel.',
          });
        }
        return o.binaryStore.read(ref);
      },
      returnJsonArray: (data: JsonObject | JsonObject[]) => (Array.isArray(data) ? data : [data]).map((json) => ({ json })),
    };
  }

  getInputData(inputIndex = 0): Item[] {
    return this.o.inputs[inputIndex] ?? [];
  }

  getInputCount(): number {
    return this.o.type.description.inputs.filter((i) => i.type === 'main').length;
  }

  getRawParameter(name: string): unknown {
    const value = getPath(this.node.parameters, name);
    return value === undefined ? getDefault(this.o.type.properties, name) : value;
  }

  getNodeParameter<T = unknown>(name: string, itemIndex: number, fallback?: T): T {
    const raw = this.getRawParameter(name);
    if (raw === undefined) return fallback as T;
    if (isNoExpression(this.o.type.properties, name)) return raw as T;
    try {
      return this.o.expressions.resolve(raw, this.scope, itemIndex) as T;
    } catch (err) {
      const e = toFlowError(err, this.node.name);
      e.itemIndex ??= itemIndex;
      e.description ??= `Parameter "${name}"`;
      throw e;
    }
  }

  evaluateExpression(expression: string, itemIndex: number, extra?: Record<string, unknown>): unknown {
    return this.o.expressions.evaluate(expression, extra ? { ...this.scope, extra } : this.scope, itemIndex);
  }

  continueOnFail(): boolean {
    return this.node.onError === 'continueRegularOutput' || this.node.onError === 'continueErrorOutput';
  }

  async forEachItem(
    fn: (item: Item, itemIndex: number) => Promise<Item | Item[] | null | undefined> | Item | Item[] | null | undefined,
  ): Promise<Item[]> {
    const out: Item[] = [];
    const items = this.getInputData();
    for (let i = 0; i < items.length; i++) {
      if (this.signal.aborted) throw this.signal.reason;
      try {
        const result = await fn(items[i]!, i);
        if (result === null || result === undefined) continue;
        for (const item of Array.isArray(result) ? result : [result]) {
          out.push(item.pairedItem === undefined && item !== items[i] ? { ...item, pairedItem: { item: i } } : item);
        }
      } catch (err) {
        if (this.o.demo && err instanceof MissingCredentialError) throw err;
        const error = toFlowError(err, this.node.name);
        error.itemIndex ??= i;
        if (this.node.onError === 'continueRegularOutput') {
          out.push({ json: { error: error.message }, pairedItem: { item: i } });
        } else if (this.node.onError === 'continueErrorOutput') {
          this.errorItems.push({ ...items[i]!, json: { ...items[i]!.json, error: error.message }, pairedItem: { item: i } });
        } else {
          throw error;
        }
      }
    }
    return out;
  }

  getNodeState<T extends object>(): T {
    let state = this.o.nodeState.get(this.node.name);
    if (!state) {
      state = {};
      this.o.nodeState.set(this.node.name, state);
    }
    return state as T;
  }

  getNodeOutput(nodeName: string): Item[] | undefined {
    const runs = this.o.runData[nodeName];
    return runs?.[runs.length - 1]?.data.main[0];
  }

  getPairedItem(nodeName: string, itemIndex: number): Item {
    return resolvePairedItem(this.o.runData, nodeName, this.o.inputs, this.o.sources, itemIndex);
  }

  getTimezone(): string {
    return this.o.timezone;
  }

  addLog(line: string): void {
    if (this.logs.length < 500) this.logs.push(line.length > 2000 ? `${line.slice(0, 2000)}…` : line);
  }

  putExecutionToWait(resumeAt: Date | null, kind: 'time' | 'webhook' | 'form'): never {
    throw new WaitSignal(resumeAt, kind);
  }

  sendWebhookResponse(response: WebhookResponse): boolean {
    return this.o.services?.webhookResponder?.send(response) ?? false;
  }

  executeWorkflow(request: SubWorkflowRequest): Promise<Item[]> {
    if (!this.o.services?.executeSubWorkflow) {
      throw new NodeOperationError('Sub-workflows cannot run here', { hint: 'Run the workflow from the editor or a trigger.' });
    }
    return this.o.services.executeSubWorkflow(request);
  }

  getResumeUrls(): { webhook: string; form: string } {
    return this.o.services?.resumeUrls ?? { webhook: '', form: '' };
  }

  getFilesRoot(): string {
    if (!this.o.filesRoot) throw new NodeOperationError('File access is not available in this run', { hint: 'Run the workflow from the editor or a trigger.' });
    return this.o.filesRoot;
  }

  getVariables(): Record<string, string> {
    return { ...this.o.variables };
  }

  getEnv(): Record<string, string> | null {
    return this.o.env ? { ...this.o.env } : null;
  }

  getInstanceSetting(key: string): unknown {
    return this.o.instanceSettings?.get(key);
  }

  getChatMemory(sessionId: string): ChatMemory {
    const store = this.o.chatMemory;
    if (!store) throw new NodeOperationError('Chat memory is not available in this run');
    const id = String(sessionId ?? '').trim();
    if (!id) throw new NodeOperationError('The chat session id is empty', { hint: 'Use {{ $json.sessionId }} from the Chat Trigger, or any text that identifies the conversation.' });
    // Sessions never cross workflows: two chats that pick the same id stay separate.
    const key = `${this.workflow.id ?? 'unsaved'}:${id.slice(0, 200)}`;
    return {
      load: (limit) => store.load(key, limit),
      append: (turns) => store.append(key, turns),
      clear: () => store.clear(key),
    };
  }

  private supplied(type: AiConnectionType, itemIndex: number): Promise<SuppliedData[]> {
    return this.o.supply ? this.o.supply(type, itemIndex) : Promise.resolve([]);
  }

  async getAiChatModel(itemIndex = 0): Promise<AiChatModel | undefined> {
    return (await this.supplied('ai_languageModel', itemIndex))[0] as AiChatModel | undefined;
  }

  async getAiMemory(itemIndex = 0): Promise<AiMemory | undefined> {
    return (await this.supplied('ai_memory', itemIndex))[0] as AiMemory | undefined;
  }

  async getAiTools(itemIndex = 0): Promise<AiTool[]> {
    return (await this.supplied('ai_tool', itemIndex)) as AiTool[];
  }

  async getCredentials(type: string): Promise<ResolvedCredential> {
    if (!this.o.type.description.credentials?.some((c) => c.type === type)) {
      throw new NodeOperationError(`Node "${this.node.name}" does not declare "${type}" credentials`);
    }
    if (!this.o.credentials) {
      throw new CredentialError('Credentials are not available in this run', { credentialType: type, hint: 'Run the workflow from the editor or a trigger.' });
    }
    return this.o.credentials.resolve(this.node, type);
  }
}
