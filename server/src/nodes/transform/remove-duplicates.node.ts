import type { Item, JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { cloneJson, fieldList, readField, removeField, stableKey, writeField } from '../_shared/fields.js';

export default defineNode({
  description: {
    type: 'flowforge.removeDuplicates',
    displayName: 'Remove Duplicates',
    description: 'Keeps the first of the items that have the same values. A second output gives the duplicates.',
    icon: 'lucide:copy-minus',
    group: 'transform',
    version: 1,
    defaults: { name: 'Remove Duplicates', color: '#9b6dd7' },
    subtitle: '{{compare}}',
    inputs: [{ type: 'main' }],
    outputs: [
      { type: 'main', displayName: 'Kept' },
      { type: 'main', displayName: 'Duplicates' },
    ],
    keywords: ['dedupe', 'deduplicate', 'unique', 'distinct'],
  },
  properties: [
    {
      name: 'compare',
      displayName: 'Compare',
      type: 'options',
      default: 'allFields',
      options: [
        { name: 'All Fields', value: 'allFields' },
        { name: 'All Fields Except', value: 'allFieldsExcept' },
        { name: 'Selected Fields', value: 'selectedFields' },
      ],
    },
    { name: 'fieldsToExclude', displayName: 'Fields To Exclude', type: 'string', default: '', placeholder: 'e.g. id, updatedAt', displayOptions: { show: { compare: ['allFieldsExcept'] } } },
    { name: 'fieldsToCompare', displayName: 'Fields To Compare', type: 'string', default: '', placeholder: 'e.g. email', displayOptions: { show: { compare: ['selectedFields'] } } },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'ignoreCase', displayName: 'Ignore Case', type: 'boolean', default: false, description: 'Treat "Ada@x.com" and "ada@x.com" as the same value.' },
        { name: 'disableDotNotation', displayName: 'Disable Dot Notation', type: 'boolean', default: false },
        { name: 'removeOtherFields', displayName: 'Remove Other Fields', type: 'boolean', default: false, description: 'Keep only the compared fields in the output (Selected Fields).' },
      ],
    },
  ],
  execute(ctx) {
    const items = ctx.getInputData();
    const compare = String(ctx.getNodeParameter('compare', 0, 'allFields'));
    const options = ctx.getNodeParameter<JsonObject>('options', 0, {});
    const dot = options.disableDotNotation !== true;
    const fields = fieldList(ctx.getNodeParameter(compare === 'selectedFields' ? 'fieldsToCompare' : 'fieldsToExclude', 0, ''));
    if (compare !== 'allFields' && fields.length === 0) {
      throw new NodeOperationError(compare === 'selectedFields' ? 'No fields to compare' : 'No fields to exclude', { hint: 'Enter field names separated by commas.' });
    }
    if (compare === 'selectedFields' && items.length) {
      const missing = fields.filter((field) => items.every((item) => readField(item.json, field, dot) === undefined));
      if (missing.length) {
        throw new NodeOperationError(`No input item has the field "${missing[0]}"`, {
          hint: `Fields of the first item: ${Object.keys(items[0]!.json).join(', ') || 'none'}. Check the name (it is case-sensitive).`,
        });
      }
    }

    const normalize = (value: unknown): unknown => {
      if (options.ignoreCase !== true) return value;
      if (typeof value === 'string') return value.toLowerCase();
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
      return value;
    };
    const keyOf = (json: JsonObject): string => {
      if (compare === 'selectedFields') return stableKey(fields.map((field) => normalize(readField(json, field, dot))));
      if (compare === 'allFields') return stableKey(normalize(json));
      const rest = cloneJson(json);
      for (const field of fields) removeField(rest, field, dot);
      return stableKey(normalize(rest));
    };

    const seen = new Set<string>();
    const kept: Item[] = [];
    const duplicates: Item[] = [];
    items.forEach((item, i) => {
      const key = keyOf(item.json);
      if (seen.has(key)) {
        duplicates.push({ ...item, pairedItem: { item: i } });
        return;
      }
      seen.add(key);
      if (compare === 'selectedFields' && options.removeOtherFields === true) {
        const json: JsonObject = {};
        for (const field of fields) {
          const value = readField(item.json, field, dot);
          if (value !== undefined) writeField(json, field, cloneJson(value), dot);
        }
        kept.push({ json, pairedItem: { item: i } });
      } else kept.push({ ...item, pairedItem: { item: i } });
    });
    return [kept, duplicates];
  },
});
