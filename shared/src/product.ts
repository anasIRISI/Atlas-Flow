// Phase 7 product layer: tags, import/export, versions, executions list, variables, templates, dashboard.
// Contract: docs/phase7-contracts.md
import type { Connections, ExecutionMode, ExecutionStatus, ExecutionSummary, WorkflowNode, WorkflowSettings } from './workflow.js';

// ── Tags (W1) ──
export interface Tag {
  id: string;
  name: string;
  /** Number of workflows using it (GET /api/tags only). */
  usageCount?: number;
  createdAt: string;
  updatedAt: string;
}

// ── Import / export (W1) ──
/** Reference to a credential kept in an exported workflow: never the secret values. */
export interface CredentialRef {
  id: string;
  name: string;
}

/** File produced by GET /api/workflows/:id/export (n8n-style workflow JSON). */
export interface WorkflowExport {
  name: string;
  nodes: WorkflowNode[];
  connections: Connections;
  settings?: WorkflowSettings;
  tags?: string[];
  meta: { exportedFrom: 'flowforge'; exportedAt: string; instanceVersion: string };
}

export interface ImportWorkflowResponse {
  id: string;
  name: string;
  /** Credential references in the file that do not exist here (the node shows "credential missing"). */
  missingCredentials: Array<{ node: string; type: string; name: string }>;
  warnings: string[];
}

// ── Versions (W2) ──
export type VersionSource = 'create' | 'save' | 'import' | 'restore';

export interface WorkflowVersionSummary {
  /** Numeric row id as a string. */
  id: string;
  workflowId: string;
  /** 1, 2, 3… per workflow. */
  number: number;
  name: string;
  source: VersionSource;
  note: string | null;
  /** Version number this one was restored from (source = restore). */
  restoredFrom: number | null;
  nodeCount: number;
  createdAt: string;
  /** Diff against the previous version (empty for version 1). */
  diff: VersionDiff;
}

export interface WorkflowVersionDetail extends WorkflowVersionSummary {
  nodes: WorkflowNode[];
  connections: Connections;
  settings: WorkflowSettings;
}

export interface VersionDiff {
  added: string[];
  removed: string[];
  /** Nodes whose parameters, type, credentials, settings or position changed (renames show as removed + added unless the id is the same). */
  changed: Array<{ node: string; fields: string[] }>;
  renamed: Array<{ from: string; to: string }>;
  connectionsChanged: boolean;
  settingsChanged: boolean;
  nameChanged: boolean;
}

// ── Executions list (W3) ──
export interface ExecutionListQuery {
  workflowId?: string;
  status?: ExecutionStatus | ExecutionStatus[];
  mode?: ExecutionMode | ExecutionMode[];
  /** ISO dates, inclusive range on the start time (created_at). */
  from?: string;
  to?: string;
  /** Page size, 1–200 (default 50). */
  limit?: number;
  /** Return executions with id < cursor (from the previous page's nextCursor). */
  cursor?: string;
}

export interface ExecutionListItem extends ExecutionSummary {
  createdAt: string;
  retryOf: string | null;
  /** stoppedAt - startedAt, null while running. */
  durationMs: number | null;
}

export interface ExecutionPage {
  items: ExecutionListItem[];
  nextCursor: string | null;
  /** Total matching the filters (without cursor). */
  total: number;
}

export interface RetryExecutionRequest {
  /** true = rerun only from the failed node, reusing the data of the nodes before it; false = rerun everything. Default true. */
  fromFailedNode?: boolean;
  /** true = use the workflow as currently saved; false = the copy stored with the execution. Default false. */
  useCurrentWorkflow?: boolean;
}

export interface PruneResult {
  deleted: number;
}

// ── Variables (W4) ──
export interface Variable {
  id: string;
  /** Letters, digits and _ ; starts with a letter or _ (like n8n). */
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

// ── Templates (W5) ──
export type TemplateCategory = 'AI' | 'Forms' | 'Email' | 'Messaging' | 'Data' | 'Scheduling' | 'Webhooks' | 'Utilities';

export interface TemplateInfo {
  /** "example:<file>" or "template:<id>". */
  id: string;
  name: string;
  description: string;
  categories: TemplateCategory[];
  nodeCount: number;
  /** Node types used (for the icons row). */
  nodeTypes: string[];
  /** Credential types needed to run it. */
  credentialTypes: string[];
  source: 'example' | 'template';
}

export interface TemplateDetail extends TemplateInfo {
  nodes: WorkflowNode[];
  connections: Connections;
}

// ── Dashboard (W5) ──
export interface DashboardStats {
  /** Last 14 days, oldest first, in the instance timezone; zero days included. */
  perDay: Array<{ day: string; success: number; error: number; other: number }>;
  totals: { executions: number; success: number; error: number; running: number; waiting: number };
  /** success / (success + error) over the 14 days, 0–1; null when nothing finished. */
  successRate: number | null;
  avgDurationMs: number | null;
  topFailing: Array<{ workflowId: string | null; workflowName: string; errors: number; lastError: string | null }>;
  recent: ExecutionListItem[];
  workflows: { total: number; active: number };
  /** One row per credential type: how many saved credentials, whether .env provides it. */
  integrations: Array<{ type: string; displayName: string; count: number; fromEnv: boolean }>;
}
