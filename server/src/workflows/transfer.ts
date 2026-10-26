import { randomUUID } from 'node:crypto';
import type { WorkflowExport, WorkflowNode, WorkflowRecord } from '@flowforge/shared';

/** Pure helpers for workflow export / import / duplicate (no I/O). Contract: docs/phase7-contracts.md (W1). */

export const INSTANCE_VERSION = '0.1.0';

export class ImportError extends Error {}

export interface CredentialLookup {
  id: string;
  name: string;
  type: string;
}

export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'workflow';
}

/** Keeps only `{ id, name }` of every credential reference. Anything else (secret-looking values) is dropped. */
export function sanitizeCredentialRefs(node: WorkflowNode): WorkflowNode {
  const creds = (node as { credentials?: unknown }).credentials;
  if (creds === undefined) return node;
  const clean: Record<string, { id: string; name: string }> = {};
  if (creds && typeof creds === 'object' && !Array.isArray(creds)) {
    for (const [type, ref] of Object.entries(creds as Record<string, unknown>)) {
      if (!ref || typeof ref !== 'object') continue;
      const r = ref as Record<string, unknown>;
      const id = typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id) : '';
      const name = typeof r.name === 'string' ? r.name : '';
      if (id || name) clean[type] = { id, name };
    }
  }
  const { credentials: _drop, ...rest } = node as WorkflowNode & { credentials?: unknown };
  return Object.keys(clean).length ? { ...rest, credentials: clean } : (rest as WorkflowNode);
}

export function buildExport(wf: WorkflowRecord, tagNames: string[], now = new Date()): WorkflowExport {
  return {
    name: wf.name,
    nodes: wf.nodes.map(sanitizeCredentialRefs),
    connections: wf.connections,
    settings: wf.settings,
    tags: tagNames,
    meta: { exportedFrom: 'flowforge', exportedAt: now.toISOString(), instanceVersion: INSTANCE_VERSION },
  };
}

/** Accepts a plain workflow, our export, or `{ workflow: … }` (also a one-element array). */
export function unwrapImport(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (Array.isArray(value) && value.length === 1) value = value[0];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (!Array.isArray(o.nodes) && o.workflow && typeof o.workflow === 'object') value = o.workflow;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ImportError('This is not a workflow file. Expected a JSON object with a "nodes" list.');
  }
  const o = value as Record<string, unknown>;
  if (!Array.isArray(o.nodes)) throw new ImportError('This is not a workflow file: the "nodes" list is missing.');
  if (o.connections !== undefined && (typeof o.connections !== 'object' || o.connections === null || Array.isArray(o.connections))) {
    throw new ImportError('The "connections" of this workflow are not valid.');
  }
  return o;
}

/** Tag names from `tags: ["a", { name: "b" }]`. */
export function importTagNames(raw: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (Array.isArray(raw.tags)) {
    for (const t of raw.tags) {
      const name = typeof t === 'string' ? t : t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string' ? (t as { name: string }).name : '';
      const clean = name.trim().slice(0, 32);
      if (clean && !out.some((x) => x.toLowerCase() === clean.toLowerCase())) out.push(clean);
    }
  }
  return out;
}

/** Fresh webhook ids so an imported / duplicated workflow never shares URLs with the original. */
export function freshWebhookIds<T extends WorkflowNode>(nodes: T[]): T[] {
  return nodes.map((n) => (n.webhookId ? { ...n, webhookId: randomUUID() } : n));
}

export interface ResolvedCredentials {
  nodes: WorkflowNode[];
  missing: Array<{ node: string; type: string; name: string }>;
}

/** Sanitizes the references and resolves them: by id, then by name (same type). Unknown ones are reported. */
export function resolveCredentialRefs(nodes: WorkflowNode[], existing: CredentialLookup[]): ResolvedCredentials {
  const missing: ResolvedCredentials['missing'] = [];
  const out = nodes.map((raw) => {
    const node = sanitizeCredentialRefs(raw);
    if (!node.credentials) return node;
    const creds: Record<string, { id: string; name: string }> = {};
    for (const [type, ref] of Object.entries(node.credentials)) {
      const found = existing.find((c) => c.type === type && ref.id && c.id === ref.id) ?? existing.find((c) => c.type === type && ref.name && c.name === ref.name);
      if (found) creds[type] = { id: found.id, name: found.name };
      else {
        creds[type] = ref;
        missing.push({ node: node.name, type, name: ref.name || ref.id });
      }
    }
    return { ...node, credentials: creds };
  });
  return { nodes: out, missing };
}

/** "<name> (copy)", then "(copy 2)"… unique among `taken`. */
export function copyName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  const root = `${base.replace(/ \(copy( \d+)?\)$/, '')}`;
  let candidate = `${root} (copy)`;
  for (let n = 2; names.has(candidate); n++) candidate = `${root} (copy ${n})`;
  return candidate.slice(0, 128);
}
