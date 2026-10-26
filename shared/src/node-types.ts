// Node descriptions are served by the backend (/api/node-types); the UI renders parameter forms from them.

export type NodeGroup = 'trigger' | 'flow' | 'transform' | 'files' | 'network' | 'integration' | 'ai' | 'ai-sub' | 'note';

export type TriggerKind = 'manual' | 'webhook' | 'schedule' | 'poll' | 'listener' | 'event';

export interface ConnectionSpec {
  type: 'main' | 'ai_languageModel' | 'ai_memory' | 'ai_tool';
  /** Label shown on the handle, e.g. "true" / "false". */
  displayName?: string;
  required?: boolean;
  /** AI slots: how many sub-nodes may be attached (default: any number). */
  maxConnections?: number;
}

export type PropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'options'
  | 'multiOptions'
  | 'json'
  | 'code'
  | 'dateTime'
  | 'color'
  | 'collection'
  | 'fixedCollection'
  | 'keyValue'
  | 'conditions'
  | 'assignments'
  | 'formFields'
  | 'workflowSelector'
  | 'webhookUrls'
  | 'curlImport'
  | 'notice';

export interface PropertyOption {
  name: string;
  value: string | number | boolean;
  description?: string;
}

export interface DisplayOptions {
  show?: Record<string, unknown[]>;
  hide?: Record<string, unknown[]>;
}

export interface NodeProperty {
  name: string;
  displayName: string;
  type: PropertyType;
  default: unknown;
  required?: boolean;
  description?: string;
  hint?: string;
  placeholder?: string;
  /** For options/multiOptions: choices. For collection/fixedCollection: child properties or groups. */
  options?: PropertyOption[] | NodeProperty[] | FixedCollectionGroup[];
  displayOptions?: DisplayOptions;
  typeOptions?: {
    rows?: number;
    password?: boolean;
    minValue?: number;
    maxValue?: number;
    numberPrecision?: number;
    language?: 'javascript' | 'json' | 'html' | 'markdown';
    multipleValues?: boolean;
    loadOptions?: string;
    /** webhookUrls: URL prefixes (e.g. "webhook" → /webhook/… and /webhook-test/…). */
    urlPrefix?: string;
    /** Not rendered in the parameter list (edited by a custom editor, e.g. the form theme). */
    editorHidden?: boolean;
  };
  /** If true the value is never evaluated as an expression (e.g. code). */
  noDataExpression?: boolean;
}

export interface FixedCollectionGroup {
  name: string;
  displayName: string;
  values: NodeProperty[];
}

export interface NodeDescription {
  type: string;
  displayName: string;
  description: string;
  icon: string;
  group: NodeGroup;
  version: number;
  defaults: { name: string; color?: string };
  /** Shown under the node name. "{{param}}" is replaced by the parameter's value (option label for options). */
  subtitle?: string;
  inputs: ConnectionSpec[];
  /** Static outputs; nodes with `dynamicOutputs` compute the real list from their parameters. */
  outputs: ConnectionSpec[];
  dynamicOutputs?: boolean;
  /** Credential types the node uses; displayOptions shows the selector only for some parameter values. */
  credentials?: { type: string; required?: boolean; displayOptions?: DisplayOptions }[];
  trigger?: { kind: TriggerKind };
  keywords?: string[];
  docsUrl?: string;
  /** Hidden from the node creator (e.g. test-only nodes). */
  hidden?: boolean;
}

export interface NodeTypeInfo extends NodeDescription {
  properties: NodeProperty[];
}
