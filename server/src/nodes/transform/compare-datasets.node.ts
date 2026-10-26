import type { Item, JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { cloneJson, fieldList, readField, stableKey, writeField } from '../_shared/fields.js';

interface MatchField {
  field1?: string;
  field2?: string;
}

/** Every leaf field of an object as dotted paths ("address.city"); arrays count as values. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : [];
  const keys = Object.keys(value as object);
  if (keys.length === 0) return prefix ? [prefix] : [];
  return keys.flatMap((k) => leafPaths((value as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
}

export default defineNode({
  description: {
    type: 'flowforge.compareDatasets',
    displayName: 'Compare Datasets',
    description: 'Compares two inputs: items only in A, the same in both, different, and only in B.',
    icon: 'lucide:git-compare',
    group: 'transform',
    version: 1,
    defaults: { name: 'Compare Datasets', color: '#9b6dd7' },
    inputs: [
      { type: 'main', displayName: 'Input A' },
      { type: 'main', displayName: 'Input B' },
    ],
    outputs: [
      { type: 'main', displayName: 'In A only' },
      { type: 'main', displayName: 'Same' },
      { type: 'main', displayName: 'Different' },
      { type: 'main', displayName: 'In B only' },
    ],
    keywords: ['diff', 'difference', 'sync', 'match', 'changes', 'compare'],
  },
  properties: [
    {
      name: 'mergeByFields',
      displayName: 'Fields To Match',
      type: 'fixedCollection',
      default: { values: [{ field1: '', field2: '' }] },
      typeOptions: { multipleValues: true },
      options: [
        {
          name: 'values',
          displayName: 'Fields',
          values: [
            { name: 'field1', displayName: 'Input A Field', type: 'string', default: '', placeholder: 'e.g. id', noDataExpression: true },
            { name: 'field2', displayName: 'Input B Field', type: 'string', default: '', placeholder: 'e.g. id (empty = same name)', noDataExpression: true },
          ],
        },
      ],
    },
    {
      name: 'resolve',
      displayName: 'When There Are Differences',
      type: 'options',
      default: 'includeBoth',
      options: [
        { name: 'Include Both Versions', value: 'includeBoth', description: 'Output what is the same and what differs, side by side' },
        { name: 'Use Input A Version', value: 'preferInput1' },
        { name: 'Use Input B Version', value: 'preferInput2' },
        { name: 'Use A Mix Of Versions', value: 'mix' },
      ],
    },
    {
      name: 'preferWhenMix',
      displayName: 'Prefer',
      type: 'options',
      default: 'input1',
      displayOptions: { show: { resolve: ['mix'] } },
      options: [
        { name: 'Input A Version', value: 'input1' },
        { name: 'Input B Version', value: 'input2' },
      ],
    },
    { name: 'exceptWhenMix', displayName: 'For Everything Except', type: 'string', default: '', placeholder: 'e.g. email, phone', description: 'These fields come from the other input.', displayOptions: { show: { resolve: ['mix'] } } },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'skipFields', displayName: 'Fields To Skip Comparing', type: 'string', default: '', placeholder: 'e.g. updatedAt' },
        { name: 'fuzzyCompare', displayName: 'Fuzzy Compare', type: 'boolean', default: false, description: 'Tolerate type differences, e.g. the number 3 equals the text "3".' },
        { name: 'disableDotNotation', displayName: 'Disable Dot Notation', type: 'boolean', default: false },
        {
          name: 'multipleMatches',
          displayName: 'Multiple Matches',
          type: 'options',
          default: 'first',
          options: [
            { name: 'Include First Match Only', value: 'first' },
            { name: 'Include All Matches', value: 'all' },
          ],
        },
      ],
    },
  ],
  execute(ctx) {
    const a = ctx.getInputData(0);
    const b = ctx.getInputData(1);
    const options = ctx.getNodeParameter<JsonObject>('options', 0, {});
    const dot = options.disableDotNotation !== true;
    const fuzzy = options.fuzzyCompare === true;
    const pairs = ctx
      .getNodeParameter<MatchField[]>('mergeByFields.values', 0, [])
      .filter((p) => p.field1?.trim())
      .map((p) => ({ a: p.field1!.trim(), b: p.field2?.trim() || p.field1!.trim() }));
    if (pairs.length === 0) throw new NodeOperationError('Add at least one field to match', { hint: 'Enter the field that identifies an item in both inputs, e.g. "id" or "email".' });
    for (const [label, items, side] of [['A', a, 'a'], ['B', b, 'b']] as const) {
      for (const pair of pairs) {
        if (items.length && items.every((item) => readField(item.json, pair[side], dot) === undefined)) {
          throw new NodeOperationError(`No item of Input ${label} has the field "${pair[side]}"`, {
            hint: `Fields of its first item: ${Object.keys(items[0]!.json).join(', ') || 'none'}. Check the name (it is case-sensitive).`,
          });
        }
      }
    }

    const norm = (value: unknown): unknown => (fuzzy && value !== null && typeof value !== 'object' && value !== undefined ? String(value) : value);
    const equal = (x: unknown, y: unknown) => stableKey(norm(x)) === stableKey(norm(y));
    const keyOf = (json: JsonObject, side: 'a' | 'b'): string | undefined => {
      const values = pairs.map((p) => readField(json, p[side], dot));
      // An item without the matching field cannot be paired.
      return values.some((v) => v === undefined || v === null) ? undefined : stableKey(values.map(norm));
    };

    const byKey = new Map<string, number[]>();
    b.forEach((item, i) => {
      const key = keyOf(item.json, 'b');
      if (key !== undefined) byKey.set(key, [...(byKey.get(key) ?? []), i]);
    });

    const skip = new Set([...fieldList(options.skipFields), ...pairs.flatMap((p) => [p.a, p.b])]);
    const usedB = new Set<number>();
    const onlyA: Item[] = [];
    const same: Item[] = [];
    const different: Item[] = [];
    const resolve = String(ctx.getNodeParameter('resolve', 0, 'includeBoth'));
    const preferA = ctx.getNodeParameter<string>('preferWhenMix', 0, 'input1') !== 'input2';
    const except = fieldList(ctx.getNodeParameter('exceptWhenMix', 0, ''));

    a.forEach((itemA, ia) => {
      const key = keyOf(itemA.json, 'a');
      const matches = key === undefined ? [] : (byKey.get(key) ?? []);
      if (matches.length === 0) {
        onlyA.push({ ...itemA, pairedItem: { item: ia, input: 0 } });
        return;
      }
      for (const ib of options.multipleMatches === 'all' ? matches : matches.slice(0, 1)) {
        const itemB = b[ib]!;
        const paired = [{ item: ia, input: 0 }, { item: ib, input: 1 }];
        const fields = [...new Set([...leafPaths(itemA.json), ...leafPaths(itemB.json)])].filter((f) => !skip.has(f) && !skip.has(f.split('.')[0]!));
        const changed = fields.filter((f) => !equal(readField(itemA.json, f), readField(itemB.json, f)));
        if (changed.length === 0) {
          same.push({ json: itemA.json, ...(itemA.binary ? { binary: itemA.binary } : {}), pairedItem: paired });
          continue;
        }
        let json: JsonObject;
        if (resolve === 'preferInput1') json = itemA.json;
        else if (resolve === 'preferInput2') json = itemB.json;
        else if (resolve === 'mix') {
          const base = cloneJson(preferA ? itemA.json : itemB.json);
          const other = preferA ? itemB.json : itemA.json;
          for (const field of except) {
            const value = readField(other, field, dot);
            if (value !== undefined) writeField(base, field, cloneJson(value), dot);
          }
          json = base;
        } else {
          const keys: JsonObject = {};
          for (const p of pairs) keys[p.a] = readField(itemA.json, p.a, dot) as JsonObject[string];
          const sameFields: JsonObject = {};
          const differentFields: JsonObject = {};
          for (const f of fields) {
            if (changed.includes(f)) {
              differentFields[f] = { inputA: (readField(itemA.json, f) ?? null) as JsonObject[string], inputB: (readField(itemB.json, f) ?? null) as JsonObject[string] };
            } else sameFields[f] = readField(itemA.json, f) as JsonObject[string];
          }
          json = { keys, same: sameFields, different: differentFields };
        }
        different.push({ json, pairedItem: paired });
      }
      for (const ib of matches) usedB.add(ib);
    });
    const onlyB: Item[] = b.flatMap((item, ib) => (usedB.has(ib) ? [] : [{ ...item, pairedItem: { item: ib, input: 1 } }]));
    return [onlyA, same, different, onlyB];
  },
});
