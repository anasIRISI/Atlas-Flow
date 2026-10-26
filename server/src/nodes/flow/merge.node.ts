import type { Item, JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { getPath } from '../../engine/params.js';
import { defineNode, type ExecuteContext } from '../../engine/types.js';

type Clash = 'preferInput2' | 'preferInput1' | 'addSuffix';
type JoinMode = 'keepMatches' | 'keepNonMatches' | 'keepEverything' | 'enrichInput1' | 'enrichInput2';

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

function deepMerge(base: JsonObject, extra: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k] as JsonObject, v) : v;
  return out;
}

function mergeJson(a: JsonObject, b: JsonObject, clash: Clash, deep: boolean): JsonObject {
  if (clash === 'addSuffix') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(a)) out[k in b ? `${k}_1` : k] = v;
    for (const [k, v] of Object.entries(b)) out[k in a ? `${k}_2` : k] = v;
    return out;
  }
  const [low, high] = clash === 'preferInput1' ? [b, a] : [a, b];
  return deep ? deepMerge(low, high) : { ...low, ...high };
}

function mergeItems(a: Item, ai: number, b: Item, bi: number, clash: Clash, deep: boolean): Item {
  const binary = a.binary || b.binary ? { ...(clash === 'preferInput1' ? b.binary : a.binary), ...(clash === 'preferInput1' ? a.binary : b.binary) } : undefined;
  return {
    json: mergeJson(a.json, b.json, clash, deep),
    ...(binary ? { binary } : {}),
    pairedItem: [{ item: ai, input: 0 }, { item: bi, input: 1 }],
  };
}

const tag = (item: Item, index: number, input: number): Item => ({ ...item, pairedItem: input === 0 ? { item: index } : { item: index, input } });

function matchFields(ctx: ExecuteContext): Array<[string, string]> {
  if (ctx.getNodeParameter<boolean>('fieldsHaveDifferentNames', 0, false)) {
    const pairs = ctx.getNodeParameter<Array<{ field1: string; field2: string }>>('mergeByFields.values', 0, []);
    return pairs.filter((p) => p.field1 && p.field2).map((p) => [p.field1.trim(), p.field2.trim()]);
  }
  return ctx
    .getNodeParameter<string>('fieldsToMatchString', 0, '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => [f, f]);
}

function combineByFields(ctx: ExecuteContext, input1: Item[], input2: Item[], clash: Clash, deep: boolean): Item[] {
  const fields = matchFields(ctx);
  if (fields.length === 0) throw new NodeOperationError('Enter the field(s) to match on', { hint: 'e.g. "id" or "email, country"' });
  const fuzzy = ctx.getNodeParameter<boolean>('options.fuzzyCompare', 0, false);
  const firstOnly = ctx.getNodeParameter<string>('options.multipleMatches', 0, 'all') === 'first';
  const join = ctx.getNodeParameter<JoinMode>('joinMode', 0, 'keepMatches');
  const from = ctx.getNodeParameter<string>('outputDataFrom', 0, 'both');

  const keyOf = (item: Item, side: 0 | 1): string | undefined => {
    const values = fields.map(([f1, f2]) => getPath(item.json, side === 0 ? f1 : f2));
    if (values.some((v) => v === undefined || v === null)) return undefined;
    return JSON.stringify(fuzzy ? values.map((v) => String(v).trim().toLowerCase()) : values);
  };
  const index = new Map<string, number[]>();
  input2.forEach((item, j) => {
    const key = keyOf(item, 1);
    if (key !== undefined) index.set(key, [...(index.get(key) ?? []), j]);
  });

  const out: Item[] = [];
  const matched2 = new Set<number>();
  const unmatched1: number[] = [];
  input1.forEach((a, i) => {
    const key = keyOf(a, 0);
    let matches = key === undefined ? [] : (index.get(key) ?? []);
    if (firstOnly) matches = matches.slice(0, 1);
    if (matches.length === 0) {
      unmatched1.push(i);
      if (join === 'enrichInput1') out.push(tag(a, i, 0));
      return;
    }
    matches.forEach((j) => matched2.add(j));
    if (join === 'keepNonMatches') return;
    if (join === 'keepMatches' && from === 'input1') return void out.push(tag(a, i, 0));
    if (join === 'keepMatches' && from === 'input2') return void matches.forEach((j) => out.push(tag(input2[j]!, j, 1)));
    if (join === 'enrichInput2') return;
    for (const j of matches) out.push(mergeItems(a, i, input2[j]!, j, clash, deep));
  });

  if (join === 'enrichInput2') {
    // Every input 2 item, enriched with its first match from input 1.
    const index1 = new Map<string, number>();
    input1.forEach((item, i) => {
      const key = keyOf(item, 0);
      if (key !== undefined && !index1.has(key)) index1.set(key, i);
    });
    return input2.map((b, j) => {
      const key = keyOf(b, 1);
      const i = key === undefined ? undefined : index1.get(key);
      return i === undefined ? tag(b, j, 1) : mergeItems(input1[i]!, i, b, j, clash === 'preferInput1' ? 'preferInput1' : 'preferInput2', deep);
    });
  }
  if (join === 'keepMatches' && from === 'input2') {
    // Deduplicate input 2 items matched several times.
    const seen = new Set<Item['json']>();
    return out.filter((item) => (seen.has(item.json) ? false : (seen.add(item.json), true)));
  }
  const unmatched2 = input2.map((_, j) => j).filter((j) => !matched2.has(j));
  if (join === 'keepNonMatches') {
    const left = from === 'input2' ? [] : unmatched1.map((i) => tag(input1[i]!, i, 0));
    const right = from === 'input1' ? [] : unmatched2.map((j) => tag(input2[j]!, j, 1));
    return [...left, ...right];
  }
  if (join === 'keepEverything') {
    return [...out, ...unmatched1.map((i) => tag(input1[i]!, i, 0)), ...unmatched2.map((j) => tag(input2[j]!, j, 1))];
  }
  return out;
}

export default defineNode({
  description: {
    type: 'flowforge.merge',
    displayName: 'Merge',
    description: 'Combines the data of two branches: append, match by fields, by position, all combinations or pick one branch.',
    icon: 'lucide:merge',
    group: 'flow',
    version: 1,
    defaults: { name: 'Merge', color: '#00bbcc' },
    subtitle: '{{mode}}',
    inputs: [
      { type: 'main', displayName: 'Input 1' },
      { type: 'main', displayName: 'Input 2' },
    ],
    outputs: [{ type: 'main' }],
    keywords: ['join', 'combine', 'append', 'concat', 'zip', 'wait'],
  },
  properties: [
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'options',
      default: 'append',
      options: [
        { name: 'Append', value: 'append', description: 'Items of input 1, then items of input 2' },
        { name: 'Combine', value: 'combine', description: 'Merge matching items together' },
        { name: 'Choose Branch', value: 'chooseBranch', description: 'Wait for both inputs and output one of them' },
      ],
    },
    {
      name: 'combineBy',
      displayName: 'Combine By',
      type: 'options',
      default: 'combineByFields',
      displayOptions: { show: { mode: ['combine'] } },
      options: [
        { name: 'Matching Fields', value: 'combineByFields', description: 'Items with the same field values are merged' },
        { name: 'Position', value: 'combineByPosition', description: 'Item 1 with item 1, item 2 with item 2, …' },
        { name: 'All Possible Combinations', value: 'combineAll', description: 'Every item of input 1 with every item of input 2' },
      ],
    },
    {
      name: 'fieldsHaveDifferentNames',
      displayName: 'Fields to Match Have Different Names',
      type: 'boolean',
      default: false,
      displayOptions: { show: { mode: ['combine'], combineBy: ['combineByFields'] } },
    },
    {
      name: 'fieldsToMatchString',
      displayName: 'Fields to Match',
      type: 'string',
      default: '',
      placeholder: 'e.g. id, email',
      displayOptions: { show: { mode: ['combine'], combineBy: ['combineByFields'], fieldsHaveDifferentNames: [false] } },
    },
    {
      name: 'mergeByFields',
      displayName: 'Fields to Match',
      type: 'fixedCollection',
      default: { values: [{ field1: '', field2: '' }] },
      typeOptions: { multipleValues: true },
      displayOptions: { show: { mode: ['combine'], combineBy: ['combineByFields'], fieldsHaveDifferentNames: [true] } },
      options: [
        {
          name: 'values',
          displayName: 'Values',
          values: [
            { name: 'field1', displayName: 'Input 1 Field', type: 'string', default: '', placeholder: 'e.g. id' },
            { name: 'field2', displayName: 'Input 2 Field', type: 'string', default: '', placeholder: 'e.g. userId' },
          ],
        },
      ],
    },
    {
      name: 'joinMode',
      displayName: 'Output Type',
      type: 'options',
      default: 'keepMatches',
      displayOptions: { show: { mode: ['combine'], combineBy: ['combineByFields'] } },
      options: [
        { name: 'Keep Matches', value: 'keepMatches', description: 'Items that match (inner join)' },
        { name: 'Keep Non-Matches', value: 'keepNonMatches', description: 'Items that do not match' },
        { name: 'Keep Everything', value: 'keepEverything', description: 'Matches merged plus all non-matches (outer join)' },
        { name: 'Enrich Input 1', value: 'enrichInput1', description: 'All input 1 items, with data from matching input 2 items (left join)' },
        { name: 'Enrich Input 2', value: 'enrichInput2', description: 'All input 2 items, with data from matching input 1 items (right join)' },
      ],
    },
    {
      name: 'outputDataFrom',
      displayName: 'Output Data From',
      type: 'options',
      default: 'both',
      displayOptions: { show: { mode: ['combine'], combineBy: ['combineByFields'], joinMode: ['keepMatches', 'keepNonMatches'] } },
      options: [
        { name: 'Both Inputs Merged Together', value: 'both' },
        { name: 'Input 1', value: 'input1' },
        { name: 'Input 2', value: 'input2' },
      ],
    },
    {
      name: 'useDataOfInput',
      displayName: 'Use Data of Input',
      type: 'options',
      default: 1,
      displayOptions: { show: { mode: ['chooseBranch'] } },
      options: [
        { name: 'Input 1', value: 1 },
        { name: 'Input 2', value: 2 },
      ],
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      displayOptions: { show: { mode: ['combine'] } },
      options: [
        {
          name: 'clashHandling',
          displayName: 'When Field Values Clash',
          type: 'options',
          default: 'preferInput2',
          options: [
            { name: 'Prefer Input 2 Version', value: 'preferInput2' },
            { name: 'Prefer Input 1 Version', value: 'preferInput1' },
            { name: 'Always Add Input Number to Field Names', value: 'addSuffix' },
          ],
        },
        { name: 'deepMerge', displayName: 'Merge Nested Fields', type: 'boolean', default: false },
        { name: 'fuzzyCompare', displayName: 'Fuzzy Compare', type: 'boolean', default: false, description: 'Treat "1" and 1, "Ada" and "ada " as equal' },
        {
          name: 'multipleMatches',
          displayName: 'Multiple Matches',
          type: 'options',
          default: 'all',
          options: [
            { name: 'Include All Matches', value: 'all' },
            { name: 'Include First Match Only', value: 'first' },
          ],
        },
        { name: 'includeUnpaired', displayName: 'Include Any Unpaired Items', type: 'boolean', default: false, description: 'Position mode: keep items without a partner' },
      ],
    },
  ],
  execute(ctx) {
    const input1 = ctx.getInputData(0);
    const input2 = ctx.getInputData(1);
    const mode = ctx.getNodeParameter<string>('mode', 0);

    if (mode === 'append') return [[...input1.map((it, i) => tag(it, i, 0)), ...input2.map((it, j) => tag(it, j, 1))]];
    if (mode === 'chooseBranch') {
      const which = Number(ctx.getNodeParameter('useDataOfInput', 0, 1));
      return [which === 2 ? input2.map((it, j) => tag(it, j, 1)) : input1.map((it, i) => tag(it, i, 0))];
    }

    const clash = ctx.getNodeParameter<Clash>('options.clashHandling', 0, 'preferInput2');
    const deep = ctx.getNodeParameter<boolean>('options.deepMerge', 0, false);
    const combineBy = ctx.getNodeParameter<string>('combineBy', 0);
    if (combineBy === 'combineByPosition') {
      const includeUnpaired = ctx.getNodeParameter<boolean>('options.includeUnpaired', 0, false);
      const length = includeUnpaired ? Math.max(input1.length, input2.length) : Math.min(input1.length, input2.length);
      const out: Item[] = [];
      for (let i = 0; i < length; i++) {
        const a = input1[i];
        const b = input2[i];
        out.push(a && b ? mergeItems(a, i, b, i, clash, deep) : a ? tag(a, i, 0) : tag(b!, i, 1));
      }
      return [out];
    }
    if (combineBy === 'combineAll') {
      return [input1.flatMap((a, i) => input2.map((b, j) => mergeItems(a, i, b, j, clash, deep)))];
    }
    return [combineByFields(ctx, input1, input2, clash, deep)];
  },
});
