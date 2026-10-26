import type { VersionDiff } from './product.js';
import type { Connections, WorkflowNode, WorkflowSettings } from './workflow.js';

export interface DiffableWorkflow {
  name: string;
  nodes: WorkflowNode[];
  connections: Connections;
  settings?: WorkflowSettings;
}

/** Key-order independent JSON. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

const FIELDS = [
  'type',
  'typeVersion',
  'parameters',
  'credentials',
  'disabled',
  'notes',
  'retryOnFail',
  'maxTries',
  'waitBetweenTries',
  'onError',
  'alwaysOutputData',
  'executeOnce',
] as const;

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
// `false` and a missing flag mean the same thing.
const norm = (field: string, v: unknown) => (['disabled', 'retryOnFail', 'alwaysOutputData', 'executeOnce'].includes(field) && v === false ? undefined : v);

/** What changed between two saved versions of a workflow (nodes are matched by id). */
export function diffWorkflows(prev: DiffableWorkflow | null | undefined, next: DiffableWorkflow): VersionDiff {
  const diff: VersionDiff = { added: [], removed: [], changed: [], renamed: [], connectionsChanged: false, settingsChanged: false, nameChanged: false };
  if (!prev) return diff;
  const before = new Map(prev.nodes.map((n) => [n.id, n]));
  const after = new Map(next.nodes.map((n) => [n.id, n]));
  for (const [id, n] of after) {
    const o = before.get(id);
    if (!o) {
      diff.added.push(n.name);
      continue;
    }
    if (o.name !== n.name) diff.renamed.push({ from: o.name, to: n.name });
    const fields: string[] = FIELDS.filter((f) => !same(norm(f, o[f]), norm(f, n[f])));
    if (!same(o.position, n.position)) fields.push('position');
    if (fields.length) diff.changed.push({ node: n.name, fields });
  }
  for (const [id, o] of before) if (!after.has(id)) diff.removed.push(o.name);
  diff.connectionsChanged = !same(prev.connections, next.connections);
  diff.settingsChanged = !same(prev.settings ?? {}, next.settings ?? {});
  diff.nameChanged = prev.name !== next.name;
  return diff;
}

export function isEmptyDiff(d: VersionDiff): boolean {
  return !d.added.length && !d.removed.length && !d.changed.length && !d.renamed.length && !d.connectionsChanged && !d.settingsChanged && !d.nameChanged;
}
