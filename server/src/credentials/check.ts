import type { DisplayOptions, JsonObject, WorkflowNode } from '@flowforge/shared';
import { withDefaults } from '../engine/params.js';
import type { CredentialsProvider, NodeType } from '../engine/types.js';

const listed = (list: unknown[], value: unknown) => (Array.isArray(value) ? value.some((v) => list.includes(v)) : list.includes(value));

/** Same rule as the editor: every `show` key must match, no `hide` key may match (a multi-select matches on any entry). */
export function matchesDisplayOptions(options: DisplayOptions | undefined, params: JsonObject): boolean {
  if (!options) return true;
  for (const [key, allowed] of Object.entries(options.show ?? {})) {
    if (!listed(allowed, params[key])) return false;
  }
  for (const [key, hidden] of Object.entries(options.hide ?? {})) {
    if (listed(hidden, params[key])) return false;
  }
  return true;
}

/** Credential types the node needs with its current parameters (e.g. Webhook → Basic Auth only when chosen). */
export function activeCredentialTypes(node: WorkflowNode, type: NodeType): string[] {
  const params = withDefaults(type.properties, node.parameters ?? {});
  return (type.description.credentials ?? []).filter((c) => c.required !== false && matchesDisplayOptions(c.displayOptions, params)).map((c) => c.type);
}

/** Throws MissingCredentialError when a needed credential cannot be found (activation / test listening). */
export function checkNodeCredentials(node: WorkflowNode, type: NodeType, provider: CredentialsProvider | undefined): void {
  if (!provider) return;
  for (const credentialType of activeCredentialTypes(node, type)) provider.resolve(node, credentialType);
}
