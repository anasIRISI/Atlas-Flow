import type { ExecutionMode, Item, RunData, TaskSource, WorkflowData } from '@flowforge/shared';

/** Everything an expression can see while a node runs. */
export interface ExpressionScope {
  workflow: WorkflowData;
  runData: RunData;
  /** Node whose parameters are being resolved. */
  nodeName: string;
  /** That node's main inputs. */
  inputs: Item[][];
  sources: (TaskSource | null)[];
  runIndex: number;
  mode: ExecutionMode;
  executionId: string;
  timezone: string;
  variables: Record<string, string>;
  /** null = `$env` access disabled in settings. */
  env: Record<string, string> | null;
  /** $execution.resumeUrl / resumeFormUrl (Wait node). */
  resumeUrl?: string;
  resumeFormUrl?: string;
  /** Values only some parameters can use, e.g. `$response` and `$pageCount` in HTTP Request pagination. */
  extra?: Record<string, unknown>;
}
