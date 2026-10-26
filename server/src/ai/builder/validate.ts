// Validation of a workflow proposed by Gemini (or by an offline template). Pure: no network, no database.
// Everything the model says is untrusted: node types must exist in the registry, parameters are checked against the
// node's schema, connections against the real inputs / outputs / AI slots. The result is FlowForge JSON.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  CONDITION_OPERATORS,
  FORM_FIELD_TYPES,
  type Connections,
  type ConnectionType,
  type FixedCollectionGroup,
  type JsonObject,
  type NodeProperty,
  type OnErrorMode,
  type WorkflowNode,
} from '@flowforge/shared';
import { matchesDisplayOptions } from '../../credentials/check.js';
import { withDefaults } from '../../engine/params.js';
import type { NodeRegistry } from '../../nodes/registry.js';
import type { Catalog, CatalogEntry } from './catalog.js';

export const MAX_NODES = 30;
export const MAX_NOTES = 5;
export const MAX_NOTE_CHARS = 200;
/** Cycles are allowed only through these nodes (Loop Over Items). */
const LOOP_TYPES = new Set(['flowforge.splitInBatches']);
const MAX_ERRORS = 20;

export interface ValidWorkflow {
  name: string;
  nodes: WorkflowNode[];
  connections: Connections;
  notes: string[];
}

export interface ValidationResult {
  workflow?: ValidWorkflow;
  errors: string[];
}

export interface ValidateContext {
  registry: NodeRegistry;
  catalog: Catalog;
  /** Name used when the answer has none. */
  defaultName?: string;
}

const ConnectionTypeSchema = z.enum(['main', 'ai_languageModel', 'ai_memory', 'ai_tool']);

const RawSchema = z.object({
  name: z.string().optional(),
  nodes: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      parameters: z.unknown().optional(),
      // Not part of the prompt contract; used by the built-in templates only.
      onError: z.enum(['stopWorkflow', 'continueRegularOutput', 'continueErrorOutput']).optional(),
    }),
  ),
  connections: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        fromOutput: z.number().int().min(0).optional(),
        toInput: z.number().int().min(0).optional(),
        type: ConnectionTypeSchema.optional(),
      }),
    )
    .default([]),
  notes: z.array(z.unknown()).optional(),
});

// ── type resolution ─────────────────────────────────────────────────────────

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** norm(key) → node types that answer to that key (type suffix, display name, name without "(…)", name inside "(…)"). */
function typeIndex(catalog: Catalog): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (key: string, type: string) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key)!.add(type);
  };
  for (const e of catalog.entries) {
    add(norm(e.type.slice(e.type.indexOf('.') + 1)), e.type);
    add(norm(e.displayName), e.type);
    const paren = /^(.*?)\s*\((.*)\)\s*$/.exec(e.displayName);
    if (paren) {
      add(norm(paren[1]!), e.type);
      add(norm(paren[2]!), e.type);
    }
  }
  return index;
}

export interface TypeResolution {
  type?: string;
  suggestions: string[];
}

/** Maps what the model wrote ("n8n-nodes-base.httpRequest", "HTTP Request", "httpRequest") to a catalog type. */
export function resolveNodeType(raw: string, catalog: Catalog, index = typeIndex(catalog)): TypeResolution {
  const text = raw.trim();
  if (catalog.byType.has(text)) return { type: text, suggestions: [] };
  const stripped = text.replace(/^(n8n-nodes-base|@n8n\/n8n-nodes-langchain|n8n-nodes-langchain|flowforge)\./i, '');
  for (const candidate of [stripped, text]) {
    const hit = index.get(norm(candidate));
    if (hit && hit.size === 1) return { type: [...hit][0]!, suggestions: [] };
  }
  const key = norm(stripped);
  const scored = catalog.entries
    .map((e) => {
      const suffix = norm(e.type.slice(e.type.indexOf('.') + 1));
      const name = norm(e.displayName);
      const near = Math.min(distance(key, suffix) / Math.max(key.length, suffix.length, 1), distance(key, name) / Math.max(key.length, name.length, 1));
      const contains = key.length >= 3 && (suffix.includes(key) || key.includes(suffix) || name.includes(key)) ? -0.3 : 0;
      return { type: e.type, score: near + contains };
    })
    .sort((a, b) => a.score - b.score || a.type.localeCompare(b.type));
  return { suggestions: scored.slice(0, 3).map((s) => s.type) };
}

// ── parameters ──────────────────────────────────────────────────────────────

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const SKIPPED = new Set(['notice', 'curlImport', 'webhookUrls']);
const FIELD_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object']);

class Problems {
  constructor(readonly errors: string[]) {}
  add(message: string) {
    if (this.errors.length < MAX_ERRORS) this.errors.push(message);
  }
}

/** "Hello {{ $json.name }}" without the leading "=" would stay literal text: add it. */
function withExpressionMark(value: string): string {
  return !value.startsWith('=') && /\{\{[\s\S]*\}\}/.test(value) ? `=${value}` : value;
}

function fixExpressions(value: unknown, noExpression: boolean): unknown {
  if (noExpression) return value;
  if (typeof value === 'string') return withExpressionMark(value);
  if (Array.isArray(value)) return value.map((v) => fixExpressions(v, false));
  if (isPlain(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fixExpressions(v, false)]));
  return value;
}

const isExpression = (v: unknown): v is string => typeof v === 'string' && v.startsWith('=');

function fieldsOf(options: NodeProperty['options']): NodeProperty[] {
  return (Array.isArray(options) ? (options as NodeProperty[]) : []).filter((o) => o && typeof o === 'object' && 'type' in o);
}

function cleanFields(props: NodeProperty[], raw: Record<string, unknown>, where: string, problems: Problems): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const prop = props.find((p) => p.name === key);
    if (!prop || SKIPPED.has(prop.type)) continue; // unknown parameter names are dropped
    out[key] = checkValue(prop, value, `${where}.${key}`, problems);
  }
  return out;
}

function checkAssignments(value: unknown, where: string, problems: Problems): unknown {
  const list = Array.isArray(value) ? value : isPlain(value) && Array.isArray(value.assignments) ? value.assignments : undefined;
  if (!list) {
    problems.add(`${where} must be { "assignments": [ { "name": "field", "value": "…", "type": "string|number|boolean|array|object" } ] }`);
    return value;
  }
  const assignments = list.map((a, i) => {
    if (!isPlain(a) || typeof a.name !== 'string' || a.name.trim() === '') {
      problems.add(`${where}.assignments[${i}] needs a non-empty "name"`);
      return a;
    }
    const inferred = typeof a.value === 'number' ? 'number' : typeof a.value === 'boolean' ? 'boolean' : Array.isArray(a.value) ? 'array' : isPlain(a.value) ? 'object' : 'string';
    const type = typeof a.type === 'string' && FIELD_TYPES.has(a.type) ? a.type : inferred;
    if (a.type !== undefined && !FIELD_TYPES.has(String(a.type))) problems.add(`${where}.assignments[${i}].type "${String(a.type)}" must be string, number, boolean, array or object`);
    return { name: a.name.trim(), value: a.value === undefined ? '' : a.value, type };
  });
  return { assignments };
}

function checkConditions(value: unknown, where: string, problems: Problems): unknown {
  if (!isPlain(value) || !Array.isArray(value.conditions) || value.conditions.length === 0) {
    problems.add(`${where} must be { "conditions": [ { "leftValue": "={{ $json.x }}", "rightValue": 1, "operator": { "type": "number", "operation": "gt" } } ], "combinator": "and" }`);
    return value;
  }
  const conditions = value.conditions.map((c, i) => {
    const at = `${where}.conditions[${i}]`;
    if (!isPlain(c) || !isPlain(c.operator)) {
      problems.add(`${at} needs "leftValue", "rightValue" and "operator": { "type", "operation" }`);
      return c;
    }
    const type = String(c.operator.type) as keyof typeof CONDITION_OPERATORS;
    const operators = CONDITION_OPERATORS[type];
    if (!operators) {
      problems.add(`${at}.operator.type "${String(c.operator.type)}" must be one of: ${Object.keys(CONDITION_OPERATORS).join(', ')}`);
      return c;
    }
    const operation = String(c.operator.operation);
    const info = operators.find((o) => o.operation === operation);
    if (!info) {
      problems.add(`${at}.operator.operation "${operation}" is not valid for type ${type}; use one of: ${operators.map((o) => o.operation).join(', ')}`);
      return c;
    }
    if (c.leftValue === undefined) problems.add(`${at} needs "leftValue"`);
    if (!info.singleValue && c.rightValue === undefined) problems.add(`${at} needs "rightValue" for the operation "${info.operation}"`);
    return { leftValue: c.leftValue, ...(info.singleValue ? {} : { rightValue: c.rightValue }), operator: { type, operation: info.operation, ...(info.singleValue ? { singleValue: true } : {}) } };
  });
  const combinator = value.combinator === 'or' ? 'or' : 'and';
  if (value.combinator !== undefined && value.combinator !== 'and' && value.combinator !== 'or') problems.add(`${where}.combinator must be "and" or "or"`);
  const options = isPlain(value.options) ? value.options : {};
  return { options: { caseSensitive: options.caseSensitive !== false, typeValidation: options.typeValidation === 'strict' ? 'strict' : 'loose' }, conditions, combinator };
}

function checkFormFields(value: unknown, where: string, problems: Problems): unknown {
  const list = Array.isArray(value) ? value : isPlain(value) && Array.isArray(value.values) ? value.values : undefined;
  if (!list || list.length === 0) {
    problems.add(`${where} must be { "values": [ { "fieldLabel": "Name", "fieldType": "text", "requiredField": true } ] }`);
    return value;
  }
  const allowed = new Set(FORM_FIELD_TYPES.map((t) => t.value as string));
  const values = list.map((f, i) => {
    if (!isPlain(f) || typeof f.fieldLabel !== 'string' || f.fieldLabel.trim() === '') {
      problems.add(`${where}.values[${i}] needs a non-empty "fieldLabel"`);
      return f;
    }
    const fieldType = f.fieldType === undefined ? 'text' : String(f.fieldType);
    if (!allowed.has(fieldType)) problems.add(`${where}.values[${i}].fieldType "${fieldType}" must be one of: ${[...allowed].join(', ')}`);
    const out: Record<string, unknown> = { ...f, id: typeof f.id === 'string' && f.id ? f.id : `field${i + 1}`, fieldLabel: f.fieldLabel.trim(), fieldType };
    if (Array.isArray(f.fieldOptions)) out.fieldOptions = { values: f.fieldOptions.map((o) => (isPlain(o) ? o : { option: String(o) })) };
    return out;
  });
  return { values };
}

function checkValue(p: NodeProperty, value: unknown, where: string, problems: Problems): unknown {
  const noExpression = p.noDataExpression === true || p.type === 'code';
  value = fixExpressions(value, noExpression);
  switch (p.type) {
    case 'string':
    case 'dateTime':
    case 'color':
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      problems.add(`${where} must be text`);
      return value;
    case 'code':
      if (typeof value !== 'string') problems.add(`${where} must be a string of code`);
      return value;
    case 'json':
      if (typeof value === 'string') return value;
      if (value !== null && typeof value === 'object') return JSON.stringify(value, null, 2);
      problems.add(`${where} must be a JSON object or text`);
      return value;
    case 'number': {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (isExpression(value)) return value;
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
      problems.add(`${where} must be a number`);
      return value;
    }
    case 'boolean':
      if (typeof value === 'boolean' || isExpression(value)) return value;
      if (value === 'true' || value === 'false') return value === 'true';
      problems.add(`${where} must be true or false`);
      return value;
    case 'options': {
      if (isExpression(value)) return value;
      const options = (Array.isArray(p.options) ? p.options : []) as { value: string | number | boolean }[];
      const hit = options.find((o) => String(o.value) === String(value)) ?? options.find((o) => String(o.value).toLowerCase() === String(value).toLowerCase());
      if (!hit) problems.add(`${where} must be one of: ${options.map((o) => String(o.value)).join(', ')} (got ${JSON.stringify(value)})`);
      return hit ? hit.value : value;
    }
    case 'multiOptions': {
      const options = (Array.isArray(p.options) ? p.options : []) as { value: string | number | boolean }[];
      const list = Array.isArray(value) ? value : [value];
      return list.map((entry) => {
        const hit = options.find((o) => String(o.value) === String(entry));
        if (!hit) problems.add(`${where} contains "${String(entry)}", allowed values: ${options.map((o) => String(o.value)).join(', ')}`);
        return hit ? hit.value : entry;
      });
    }
    case 'assignments':
      return checkAssignments(value, where, problems);
    case 'conditions':
      return checkConditions(value, where, problems);
    case 'formFields':
      return checkFormFields(value, where, problems);
    case 'keyValue': {
      const list = Array.isArray(value) ? value : isPlain(value) ? Object.entries(value).map(([name, v]) => ({ name, value: v })) : undefined;
      if (!list) {
        problems.add(`${where} must be a list like [ { "name": "key", "value": "text" } ]`);
        return value;
      }
      return list.map((entry, i) => {
        if (!isPlain(entry) || typeof entry.name !== 'string') {
          problems.add(`${where}[${i}] needs "name" and "value"`);
          return entry;
        }
        return { name: entry.name, value: entry.value === undefined ? '' : entry.value };
      });
    }
    case 'collection':
      if (!isPlain(value)) {
        problems.add(`${where} must be an object`);
        return value;
      }
      return cleanFields(fieldsOf(p.options), value, where, problems);
    case 'fixedCollection': {
      if (!isPlain(value)) {
        problems.add(`${where} must be an object`);
        return value;
      }
      const groups = (Array.isArray(p.options) ? p.options : []) as unknown as FixedCollectionGroup[];
      const out: Record<string, unknown> = {};
      for (const [key, groupValue] of Object.entries(value)) {
        const group = groups.find((g) => g.name === key);
        if (!group) continue;
        const defaultValue = isPlain(p.default) ? p.default[key] : undefined;
        const asList = Array.isArray(groupValue) || Array.isArray(defaultValue) || p.typeOptions?.multipleValues === true;
        const entries = Array.isArray(groupValue) ? groupValue : [groupValue];
        const cleaned = entries.map((entry, i) => {
          if (!isPlain(entry)) {
            problems.add(`${where}.${key}[${i}] must be an object`);
            return entry;
          }
          return cleanFields(group.values ?? [], entry, `${where}.${key}[${i}]`, problems);
        });
        out[key] = asList ? cleaned : cleaned[0];
      }
      return out;
    }
    default:
      return value;
  }
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function cleanParameters(entryType: string, registry: NodeRegistry, raw: unknown, name: string, problems: Problems): JsonObject {
  const type = registry.require(entryType);
  const where = `Node "${name}" parameter`;
  if (raw !== undefined && raw !== null && !isPlain(raw)) {
    problems.add(`Node "${name}": "parameters" must be an object`);
    return {};
  }
  const cleaned = cleanFields(type.properties, (raw ?? {}) as Record<string, unknown>, where, problems) as JsonObject;
  const effective = withDefaults(type.properties, cleaned);
  for (const p of type.properties) {
    if (p.required !== true || SKIPPED.has(p.type)) continue;
    if (!matchesDisplayOptions(p.displayOptions, effective)) continue;
    if (isEmpty(effective[p.name])) problems.add(`Node "${name}": required parameter "${p.name}" (${p.displayName}) is missing`);
  }
  return cleaned;
}

// ── workflow ────────────────────────────────────────────────────────────────

interface BuiltNode {
  node: WorkflowNode;
  entry: CatalogEntry;
}

interface Edge {
  from: string;
  to: string;
  type: ConnectionType;
  fromOutput: number;
  toInput: number;
}

const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

export function validateWorkflow(raw: unknown, ctx: ValidateContext): ValidationResult {
  const problems = new Problems([]);
  const fail = () => ({ errors: problems.errors });

  const parsed = RawSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 6)) problems.add(`JSON shape: ${issue.path.join('.') || '(root)'} ${issue.message}`);
    return fail();
  }
  const data = parsed.data;
  if (data.nodes.length < 1) problems.add('The workflow has no nodes');
  if (data.nodes.length > MAX_NODES) problems.add(`The workflow has ${data.nodes.length} nodes, the limit is ${MAX_NODES}`);
  if (data.nodes.length < 1 || data.nodes.length > MAX_NODES) return fail();

  // 1. nodes
  const index = typeIndex(ctx.catalog);
  const built = new Map<string, BuiltNode>();
  for (const [i, n] of data.nodes.entries()) {
    const name = n.name.trim();
    if (!name) {
      problems.add(`Node #${i + 1} has an empty name`);
      continue;
    }
    if (name.length > 100 || FORBIDDEN_NAMES.has(name)) {
      problems.add(`Node name "${name.slice(0, 40)}" is not allowed (use a short readable name)`);
      continue;
    }
    if (built.has(name)) {
      problems.add(`Duplicate node name "${name}": every name must be unique`);
      continue;
    }
    const resolved = resolveNodeType(n.type, ctx.catalog, index);
    if (!resolved.type) {
      problems.add(`Node "${name}": the type "${n.type}" does not exist. Closest valid types: ${resolved.suggestions.join(', ')}`);
      continue;
    }
    const entry = ctx.catalog.byType.get(resolved.type)!;
    const parameters = cleanParameters(resolved.type, ctx.registry, n.parameters, name, problems);
    const node: WorkflowNode = {
      id: randomUUID(),
      name,
      type: resolved.type,
      typeVersion: 1,
      position: [0, 0],
      parameters,
      ...(n.onError ? { onError: n.onError as OnErrorMode } : {}),
      ...(ctx.registry.require(resolved.type).description.trigger?.kind === 'webhook' ? { webhookId: randomUUID() } : {}),
    };
    built.set(name, { node, entry });
  }

  // 2. connections
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const incomingAi = new Map<string, number>(); // `${target}|${type}` → count
  for (const [i, c] of data.connections.entries()) {
    const label = `Connection #${i + 1} (${c.from} → ${c.to})`;
    const source = built.get(c.from.trim());
    const target = built.get(c.to.trim());
    if (!source || !target) {
      const missing = [!source ? c.from : '', !target ? c.to : ''].filter(Boolean).map((x) => `"${x}"`).join(' and ');
      // A node that failed above already has its own error.
      if (!data.nodes.some((n) => [c.from, c.to].includes(n.name.trim()) && !built.has(n.name.trim()))) problems.add(`${label}: ${missing} is not a node of this workflow`);
      continue;
    }
    if (source === target) {
      problems.add(`${label}: a node cannot connect to itself`);
      continue;
    }
    const type: ConnectionType = c.type ?? source.entry.aiOutput ?? 'main';
    const fromOutput = c.fromOutput ?? 0;
    const toInput = c.toInput ?? 0;
    if (type === 'main') {
      if (source.entry.aiOutput) {
        problems.add(`${label}: "${source.node.name}" is an AI sub-node, connect it with type "${source.entry.aiOutput}" to the node that uses it`);
        continue;
      }
      if (target.entry.isTrigger || target.entry.mainInputs === 0) {
        problems.add(`${label}: "${target.node.name}" has no input to connect to (a trigger starts the workflow, nothing connects into it)`);
        continue;
      }
      const outputs = ctx.registry.outputsFor(source.node).length;
      if (fromOutput >= outputs) {
        problems.add(`${label}: "${source.node.name}" has ${outputs} output(s), so fromOutput ${fromOutput} does not exist (valid: 0${outputs > 1 ? `-${outputs - 1}` : ''})`);
        continue;
      }
      if (toInput >= target.entry.mainInputs) {
        problems.add(`${label}: "${target.node.name}" has ${target.entry.mainInputs} input(s), so toInput ${toInput} does not exist`);
        continue;
      }
    } else {
      if (source.entry.aiOutput !== type) {
        problems.add(`${label}: "${source.node.name}" does not supply "${type}"${source.entry.aiOutput ? ` (it supplies ${source.entry.aiOutput})` : ' (it is not an AI sub-node)'}`);
        continue;
      }
      const slot = target.entry.aiSlots.find((s) => s.type === type);
      if (!slot) {
        problems.add(`${label}: "${target.node.name}" has no "${type}" slot, so a sub-node cannot be attached to it`);
        continue;
      }
      const key = `${target.node.name}|${type}`;
      const count = (incomingAi.get(key) ?? 0) + 1;
      incomingAi.set(key, count);
      if (slot.max !== undefined && count > slot.max) {
        problems.add(`${label}: "${target.node.name}" accepts at most ${slot.max} "${type}" sub-node(s)`);
        continue;
      }
    }
    const id = `${source.node.name}|${type}|${type === 'main' ? fromOutput : 0}|${target.node.name}|${type === 'main' ? toInput : 0}`;
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({ from: source.node.name, to: target.node.name, type, fromOutput: type === 'main' ? fromOutput : 0, toInput: type === 'main' ? toInput : 0 });
  }

  // 3. graph rules (skipped when nodes are missing: the errors above already explain what to fix)
  if (problems.errors.length === 0) {
    checkGraph(built, edges, problems);
  }
  if (problems.errors.length > 0) return fail();

  const notes = (data.notes ?? [])
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    .slice(0, MAX_NOTES)
    .map((n) => clip(n.replace(/\s+/g, ' ').trim(), MAX_NOTE_CHARS));
  const name = clip((data.name ?? '').replace(/\s+/g, ' ').trim() || ctx.defaultName || 'AI workflow', 80);
  return { workflow: { name, nodes: [...built.values()].map((b) => b.node), connections: toConnections(edges), notes }, errors: [] };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function checkGraph(built: Map<string, BuiltNode>, edges: Edge[], problems: Problems): void {
  const nodes = [...built.values()];
  const triggers = nodes.filter((b) => b.entry.isTrigger);
  if (triggers.length === 0) problems.add('The workflow has no trigger node: start it with a trigger (for example Manual Trigger, Webhook, Schedule Trigger)');

  // sub-nodes must be attached, required slots filled
  for (const b of nodes) {
    if (b.entry.aiOutput && !edges.some((e) => e.from === b.node.name && e.type === b.entry.aiOutput)) {
      problems.add(`Sub-node "${b.node.name}" is not attached: connect it (type "${b.entry.aiOutput}") to the node that uses it`);
    }
    for (const slot of b.entry.aiSlots) {
      if (slot.required && !edges.some((e) => e.to === b.node.name && e.type === slot.type)) {
        problems.add(`Node "${b.node.name}" needs a "${slot.type}" sub-node${slot.displayName ? ` (${slot.displayName})` : ''}: add one and connect it with type "${slot.type}"`);
      }
    }
  }

  // every non-trigger node reachable from a trigger; sub-nodes through their parent
  const reachable = new Set(triggers.map((t) => t.node.name));
  const mainEdges = edges.filter((e) => e.type === 'main');
  const aiEdges = edges.filter((e) => e.type !== 'main');
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of mainEdges) if (reachable.has(e.from) && !reachable.has(e.to)) (reachable.add(e.to), (changed = true));
    for (const e of aiEdges) if (reachable.has(e.to) && !reachable.has(e.from)) (reachable.add(e.from), (changed = true));
  }
  for (const b of nodes) {
    // (an unattached sub-node already has its own error above)
    const unattached = b.entry.aiOutput !== undefined && !aiEdges.some((e) => e.from === b.node.name);
    if (!reachable.has(b.node.name) && !unattached) {
      problems.add(`Node "${b.node.name}" is not reachable from a trigger: connect it to the flow`);
    }
  }

  // cycles only through Loop Over Items
  const loops = new Set(nodes.filter((b) => LOOP_TYPES.has(b.node.type)).map((b) => b.node.name));
  const rest = nodes.filter((b) => !loops.has(b.node.name)).map((b) => b.node.name);
  const indegree = new Map(rest.map((n) => [n, 0]));
  const relevant = mainEdges.filter((e) => indegree.has(e.from) && indegree.has(e.to));
  for (const e of relevant) indegree.set(e.to, indegree.get(e.to)! + 1);
  const queue = rest.filter((n) => indegree.get(n) === 0);
  let done = 0;
  while (queue.length) {
    const n = queue.shift()!;
    done++;
    for (const e of relevant) if (e.from === n) (indegree.set(e.to, indegree.get(e.to)! - 1), indegree.get(e.to) === 0 && queue.push(e.to));
  }
  if (done < rest.length) {
    const stuck = rest.filter((n) => indegree.get(n)! > 0).slice(0, 4);
    problems.add(`The connections form a loop (${stuck.map((s) => `"${s}"`).join(', ')}): a loop is only allowed through a Loop Over Items node`);
  }
}

function toConnections(edges: Edge[]): Connections {
  const connections: Connections = {};
  for (const e of edges) {
    const bySource = (connections[e.from] ??= {});
    const lists = (bySource[e.type] ??= []);
    while (lists.length <= e.fromOutput) lists.push([]);
    lists[e.fromOutput]!.push({ node: e.to, type: e.type, index: e.toInput });
  }
  return connections;
}
