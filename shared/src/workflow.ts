// Workflow + item data model. Deliberately close to n8n's JSON so the format feels familiar.

export type JsonObject = { [key: string]: unknown };

/** Reference to binary content stored on disk (never inlined in items). */
export interface BinaryRef {
  /** `<executionId>/<uuid>` */
  id: string;
  mimeType: string;
  fileName?: string;
  fileExtension?: string;
  fileSize: number;
}

/** Points to the input item an output item was derived from (used by `$('Node').item`). */
export interface PairedItem {
  item: number;
  /** Input index, default 0. */
  input?: number;
}

export interface Item {
  json: JsonObject;
  binary?: Record<string, BinaryRef>;
  pairedItem?: PairedItem | PairedItem[];
}

export type ConnectionType = 'main' | 'ai_languageModel' | 'ai_memory' | 'ai_tool';

export interface ConnectionTarget {
  node: string;
  type: ConnectionType;
  index: number;
}

/** connections[sourceNode][type][outputIndex] = targets */
export type Connections = Record<string, Partial<Record<ConnectionType, ConnectionTarget[][]>>>;

export type OnErrorMode = 'stopWorkflow' | 'continueRegularOutput' | 'continueErrorOutput';

export interface WorkflowNode {
  id: string;
  /** Unique within the workflow; used by connections and `$('Name')`. */
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: JsonObject;
  credentials?: Record<string, { id: string; name: string }>;
  disabled?: boolean;
  notes?: string;
  retryOnFail?: boolean;
  /** 1–5, default 3 */
  maxTries?: number;
  /** ms, 0–5000, default 1000 */
  waitBetweenTries?: number;
  onError?: OnErrorMode;
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
  webhookId?: string;
}

export interface WorkflowSettings {
  /** Seconds; 0 or missing = instance default. */
  executionTimeout?: number;
  timezone?: string;
  /** Id of the workflow started (via its Error Trigger) when a production execution fails. */
  errorWorkflow?: string;
  /** Production executions only: keep the data of successful / failed runs (default: all). */
  saveDataSuccessExecution?: 'all' | 'none';
  saveDataErrorExecution?: 'all' | 'none';
}

export interface WorkflowData {
  id?: string;
  name: string;
  active?: boolean;
  nodes: WorkflowNode[];
  connections: Connections;
  settings?: WorkflowSettings;
  /** Output items per node used instead of executing it (manual runs only). */
  pinData?: Record<string, Item[]>;
}

/** Activation status shown next to the Active toggle. */
export interface ActivationInfo {
  active: boolean;
  /** Why the last activation failed (the workflow is inactive). */
  activationError: string | null;
  /** A trigger failed while the workflow was active (status turns red). */
  triggerError: string | null;
  triggerErrorAt: string | null;
}

/** A stored workflow as returned by the API. */
export interface WorkflowRecord extends Omit<WorkflowData, 'active'>, ActivationInfo {
  id: string;
  versionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowSummary extends ActivationInfo {
  id: string;
  name: string;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
  /** Phase 7 (filled by GET /api/workflows). */
  tags?: Array<{ id: string; name: string }>;
  /** Status and start time of the latest execution (status dot in the list). */
  lastExecutionStatus?: ExecutionStatus | null;
  lastExecutionAt?: string | null;
}

/** Body of POST /api/workflows/:id/test-listen ("Listen for test event"). */
export interface TestListenRequest {
  workflow: WorkflowData;
  nodeName: string;
}

export interface TestListenResponse {
  kind: 'webhook' | 'schedule' | 'poll' | 'listener' | 'event' | 'manual';
  /** For webhooks: the URL to call. */
  testUrl?: string;
  method?: string;
  expiresAt?: string;
  /** For triggers that run right away (schedule, poll): the started execution. */
  executionId?: string;
}

/** Body of POST /api/executions/run (manual run from the editor). */
export interface RunWorkflowRequest {
  workflow: WorkflowData;
  startNode?: string;
  /** "Execute step": run only what this node needs, then stop. */
  destinationNode?: string;
  /** Reuse data of this execution for nodes that do not need to run again. */
  previousExecutionId?: string;
  /** Time travel "Re-run from here": this node and everything after it run again, the rest reuses `previousExecutionId`. */
  rerunFrom?: string;
}

export type ExecutionMode = 'manual' | 'trigger' | 'webhook' | 'schedule' | 'form' | 'chat' | 'error' | 'subworkflow' | 'retry';

export type ExecutionStatus = 'queued' | 'running' | 'waiting' | 'success' | 'error' | 'canceled' | 'crashed';

/** Where the data on one input of a node run came from. */
export interface TaskSource {
  previousNode: string;
  previousNodeOutput: number;
  previousNodeRun: number;
}

export interface SerializedError {
  name: string;
  message: string;
  description?: string;
  hint?: string;
  node?: string;
  itemIndex?: number;
  /** For expression errors: the expression that failed. */
  expression?: string;
  /** For missing/invalid credentials: lets the UI offer "Open Credentials". */
  credentialType?: string;
  /** Saved credential that failed (e.g. wrong password): the UI opens it for editing. */
  credentialId?: string;
  envVar?: string;
  docsAnchor?: string;
}

export type NodeRunStatus = 'success' | 'error' | 'disabled' | 'pinned' | 'reused';

export interface NodeRun {
  startTime: number;
  executionTime: number;
  status: NodeRunStatus;
  /** One entry per input (null when that input received no data). */
  source: (TaskSource | null)[];
  data: { main: Item[][] };
  error?: SerializedError;
  /**
   * Demo Mode only: the node had no credential, so it returned made-up output (items carry `_simulated: true`).
   * Never set outside Demo Mode (see docs/phase8-contracts.md).
   */
  simulated?: boolean;
  /** Lines printed with console.log (Code node). */
  logs?: string[];
}

export type RunData = Record<string, NodeRun[]>;

export interface ExecutionSummary {
  id: string;
  workflowId: string | null;
  workflowName: string;
  mode: ExecutionMode;
  status: ExecutionStatus;
  startedAt: string | null;
  stoppedAt: string | null;
  lastNodeExecuted: string | null;
  errorMessage: string | null;
  parentExecutionId: string | null;
  /** When status is "waiting": when it resumes (null = on webhook call / form). */
  waitTill: string | null;
  waitingNode: string | null;
}

export interface ExecutionDetail extends ExecutionSummary {
  workflow: WorkflowData;
  runData: RunData;
  error: SerializedError | null;
  events: ExecutionEvent[];
}

/** Compact ordered log of what happened (powers the time-travel debugger later). */
export interface ExecutionEvent {
  seq: number;
  ts: number;
  type: 'node.started' | 'node.finished';
  node: string;
  runIndex: number;
  status?: NodeRunStatus;
}

export const EXPRESSION_PREFIX = '=';

export function isExpression(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(EXPRESSION_PREFIX);
}
