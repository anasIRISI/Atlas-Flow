// Node catalog shown to Gemini: built from the node registry (never hand-written), so the AI can only name nodes
// and parameters that really exist. Compact text, adaptive detail to stay under `maxChars`.
import type { ConnectionSpec, NodeProperty, TriggerKind, WorkflowNode } from '@flowforge/shared';
import type { NodeRegistry } from '../../nodes/registry.js';

export type AiSlotType = 'ai_languageModel' | 'ai_memory' | 'ai_tool';

export interface CatalogParam {
  name: string;
  type: string;
  required: boolean;
  /** Allowed values of an options / multiOptions parameter. */
  options?: string[];
  /** Short scalar default. */
  default?: string;
  /** Visibility condition, e.g. "mode=manual". */
  show?: string;
  /** Collection children ("name:type") or fixed-collection groups ("group[name:type, …]"). */
  children?: string[];
}

export interface CatalogEntry {
  type: string;
  displayName: string;
  description: string;
  group: string;
  isTrigger: boolean;
  trigger?: TriggerKind;
  mainInputs: number;
  /** Main outputs with the default parameters: label when the node names it ("true"), else undefined. */
  outputs: (string | undefined)[];
  dynamicOutputs: boolean;
  /** AI slots a parent node offers (Chat Model, Memory, Tool). */
  aiSlots: { type: AiSlotType; displayName?: string; required: boolean; max?: number }[];
  /** Set for a sub-node: the AI connection type it supplies. */
  aiOutput?: AiSlotType;
  credentials: string[];
  params: CatalogParam[];
}

export interface Catalog {
  entries: CatalogEntry[];
  byType: Map<string, CatalogEntry>;
  /** The text put in the prompt (≤ maxChars). */
  text: string;
}

export interface CatalogOptions {
  /** Tests only: also list hidden nodes (e.g. test.aiHarness). */
  includeHidden?: boolean;
  maxChars?: number;
}

export const CATALOG_MAX_CHARS = 12_000;
const SKIPPED_PARAM_TYPES = new Set(['notice', 'curlImport', 'webhookUrls']);
const AI_TYPES = new Set(['ai_languageModel', 'ai_memory', 'ai_tool']);

const isAi = (s: ConnectionSpec) => AI_TYPES.has(s.type);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function scalarDefault(value: unknown): string | undefined {
  if (typeof value === 'string') return value !== '' && value.length <= 24 && !value.includes('\n') ? JSON.stringify(value) : undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function showText(p: NodeProperty): string | undefined {
  const show = p.displayOptions?.show;
  if (!show) return undefined;
  const parts = Object.entries(show).map(([k, v]) => `${k}=${v.map((x) => String(x)).join('|')}`);
  return parts.length ? parts.join(',') : undefined;
}

function children(p: NodeProperty): string[] | undefined {
  if (!Array.isArray(p.options) || p.options.length === 0) return undefined;
  if (p.type === 'collection') return (p.options as NodeProperty[]).map((c) => `${c.name}:${c.type}`);
  if (p.type === 'fixedCollection') {
    return (p.options as unknown as { name: string; values?: NodeProperty[] }[]).map((g) => `${g.name}[${(g.values ?? []).map((v) => `${v.name}:${v.type}`).join(', ')}]`);
  }
  return undefined;
}

function toParam(p: NodeProperty): CatalogParam | undefined {
  if (SKIPPED_PARAM_TYPES.has(p.type) || p.typeOptions?.editorHidden) return undefined;
  const param: CatalogParam = { name: p.name, type: p.type, required: p.required === true };
  if ((p.type === 'options' || p.type === 'multiOptions') && Array.isArray(p.options)) {
    param.options = (p.options as { value: unknown }[]).filter((o) => o && 'value' in o).map((o) => String(o.value));
  }
  const def = scalarDefault(p.default);
  if (def !== undefined) param.default = def;
  const show = showText(p);
  if (show) param.show = show;
  const kids = children(p);
  if (kids) param.children = kids;
  return param;
}

function describe(registry: NodeRegistry, type: string): CatalogEntry | undefined {
  const node = registry.get(type);
  if (!node) return undefined;
  const d = node.description;
  let outputs: ConnectionSpec[];
  try {
    outputs = registry.outputsFor({ id: 'x', name: 'x', type, typeVersion: 1, position: [0, 0], parameters: {} } as WorkflowNode);
  } catch {
    outputs = d.outputs.filter((o) => o.type === 'main');
  }
  const aiOut = d.outputs.find(isAi);
  return {
    type,
    displayName: d.displayName,
    description: oneLine(d.description),
    group: d.group,
    isTrigger: d.group === 'trigger' || d.trigger !== undefined,
    trigger: d.trigger?.kind,
    mainInputs: d.inputs.filter((i) => i.type === 'main').length,
    outputs: outputs.map((o) => o.displayName),
    dynamicOutputs: d.dynamicOutputs === true,
    aiSlots: d.inputs.filter(isAi).map((i) => ({ type: i.type as AiSlotType, displayName: i.displayName, required: i.required === true, max: i.maxConnections })),
    aiOutput: aiOut ? (aiOut.type as AiSlotType) : undefined,
    credentials: (d.credentials ?? []).map((c) => c.type),
    params: node.properties.map(toParam).filter((p): p is CatalogParam => p !== undefined),
  };
}

function paramText(p: CatalogParam, level: number): string {
  let s = p.name + (p.required ? '*' : '');
  if (p.options) {
    const shown = level >= 3 && p.options.length > 4 ? [...p.options.slice(0, 4), '…'] : level === 2 && p.options.length > 8 ? [...p.options.slice(0, 8), '…'] : p.options;
    s += `:${shown.join('|')}`;
  } else s += `:${p.type}`;
  if (level === 0 && p.default !== undefined) s += `=${p.default}`;
  if (p.show && (level <= 2 || p.required)) s += ` @${level >= 2 ? p.show.split(',')[0] : p.show}`;
  if (p.children) s += level === 0 ? `{${p.children.join(', ')}}` : level === 1 ? `{${p.children.map((c) => c.split(/[:[]/)[0]).join(',')}}` : '';
  return s;
}

function entryText(e: CatalogEntry, level: number): string {
  const head: string[] = [`- ${e.type} "${e.displayName}" [${e.isTrigger ? `trigger:${e.trigger ?? 'manual'}` : e.group}]`];
  if (e.aiOutput) head.push(`SUB-NODE supplying ${e.aiOutput} (connect FROM it TO a parent with that slot)`);
  else {
    const labelled = e.outputs.some((o) => o !== undefined);
    const parts: string[] = [];
    if (!e.isTrigger && e.mainInputs !== 1) parts.push(`in:${e.mainInputs}`);
    if (e.dynamicOutputs) parts.push('out:variable (set by the parameters, one per rule/case)');
    else if (e.outputs.length !== 1 || labelled) parts.push(`out:${e.outputs.length}${labelled ? `(${e.outputs.map((o, i) => o ?? String(i)).join('/')})` : ''}`);
    if (parts.length) head.push(parts.join(' '));
    if (e.aiSlots.length) head.push(`AI slots: ${e.aiSlots.map((s) => `${s.type}${s.required ? ' REQUIRED' : ''}${s.max ? ` max${s.max}` : ''}`).join(', ')}`);
  }
  if (level <= 2) head.push(clip(e.description, level === 0 ? 140 : level === 1 ? 90 : 60));
  if (e.credentials.length && level <= 1) head.push(`credentials: ${e.credentials.join(',')}`);
  let params = e.params;
  if (level === 3) params = params.slice(0, 14);
  if (level >= 4) params = [...params.filter((p) => p.required), ...params.filter((p) => !p.required)].slice(0, Math.max(5, params.filter((p) => p.required).length));
  const list = params.map((p) => paramText(p, Math.min(level, 3))).join('; ');
  return `${head.join(' | ')}${list ? `\n    params: ${list}` : ''}`;
}

/** Nodes whose detail is shortened last (they are the ones nearly every workflow uses). */
const CORE_TYPES = new Set([
  'flowforge.manualTrigger', 'flowforge.webhook', 'flowforge.scheduleTrigger', 'flowforge.formTrigger', 'flowforge.chatTrigger', 'flowforge.telegramTrigger', 'flowforge.rssFeedTrigger',
  'flowforge.set', 'flowforge.if', 'flowforge.switch', 'flowforge.filter', 'flowforge.code', 'flowforge.merge', 'flowforge.httpRequest', 'flowforge.respondToWebhook',
  'flowforge.sendEmail', 'flowforge.telegram', 'flowforge.discord', 'flowforge.openMeteo', 'flowforge.googleGemini', 'flowforge.splitInBatches',
]);
const importance = (e: CatalogEntry) => (CORE_TYPES.has(e.type) || e.aiOutput || e.aiSlots.length > 0 ? 1 : 0);

/** Entries with the lowest value are dropped first when even the shortest form does not fit. */
const DROP_FIRST = ['files', 'transform', 'ai', 'integration', 'network', 'flow'];
function keepValue(e: CatalogEntry): number {
  if (e.trigger === 'manual') return 99;
  if (e.aiOutput || e.aiSlots.length > 0) return 20;
  if (e.isTrigger) return 10;
  return Math.max(0, DROP_FIRST.indexOf(e.group));
}

export function buildCatalog(registry: NodeRegistry, options: CatalogOptions = {}): Catalog {
  const maxChars = options.maxChars ?? CATALOG_MAX_CHARS;
  const entries = registry
    .list(options.includeHidden === true)
    .filter((t) => t.type !== 'flowforge.stickyNote' && t.group !== 'note')
    .map((t) => describe(registry, t.type))
    .filter((e): e is CatalogEntry => e !== undefined)
    // Triggers first, then the cluster nodes, then everything else: the model reads the start of the list best.
    .sort((a, b) => Number(b.isTrigger) - Number(a.isTrigger) || a.type.localeCompare(b.type));

  const levels = new Map<string, number>(entries.map((e) => [e.type, 0]));
  const texts = new Map<string, string>(entries.map((e) => [e.type, entryText(e, 0)]));
  const kept = [...entries];
  const total = () => kept.reduce((n, e) => n + texts.get(e.type)!.length + 1, 0);

  const lastLevel = (e: CatalogEntry, pass: number) => (importance(e) === 1 && pass === 0 ? 3 : 4);
  let pass = 0;
  while (total() > maxChars) {
    // Shorten the least important (then the biggest) entry that can still be shortened.
    const candidate = kept
      .filter((e) => levels.get(e.type)! < lastLevel(e, pass))
      .sort((a, b) => importance(a) - importance(b) || texts.get(b.type)!.length - texts.get(a.type)!.length)[0];
    if (candidate) {
      const next = levels.get(candidate.type)! + 1;
      levels.set(candidate.type, next);
      texts.set(candidate.type, entryText(candidate, next));
      continue;
    }
    if (pass === 0) {
      pass = 1; // the core nodes may now be shortened to the last form too
      continue;
    }
    // Everything is at the shortest form: drop the least useful node.
    const victim = [...kept].reverse().sort((a, b) => keepValue(a) - keepValue(b))[0];
    if (!victim || kept.length <= 1) break;
    kept.splice(kept.indexOf(victim), 1);
  }

  return {
    entries: kept,
    byType: new Map(kept.map((e) => [e.type, e])),
    text: kept.map((e) => texts.get(e.type)!).join('\n'),
  };
}
