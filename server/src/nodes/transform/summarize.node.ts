import type { Item, JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { fieldList, readField, stableKey } from '../_shared/fields.js';

type Aggregation = 'append' | 'average' | 'concatenate' | 'count' | 'countUnique' | 'max' | 'min' | 'sum';

interface Summary {
  aggregation?: Aggregation;
  field?: string;
  includeEmpty?: boolean;
  separateBy?: string;
}

const PREFIX: Record<Aggregation, string> = {
  append: 'appended_',
  average: 'average_',
  concatenate: 'concatenated_',
  count: 'count_',
  countUnique: 'unique_count_',
  max: 'max_',
  min: 'min_',
  sum: 'sum_',
};
const NUMERIC: Aggregation[] = ['average', 'max', 'min', 'sum'];

const isEmpty = (v: unknown) => v === undefined || v === null || v === '';
const outputName = (s: Required<Pick<Summary, 'aggregation' | 'field'>>) => `${PREFIX[s.aggregation]}${s.field.replace(/\./g, '_')}`;

function summarize(spec: Summary & { aggregation: Aggregation; field: string }, values: unknown[]): unknown {
  const present = spec.includeEmpty ? values : values.filter((v) => !isEmpty(v));
  switch (spec.aggregation) {
    case 'count':
      return present.length;
    case 'countUnique':
      return new Set(present.map(stableKey)).size;
    case 'append':
      return present.map((v) => (v === undefined ? null : v));
    case 'concatenate':
      return present.map((v) => (isEmpty(v) ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))).join(spec.separateBy ?? ', ');
    default: {
      const numbers = values.filter((v) => !isEmpty(v)).map((v) => (typeof v === 'number' ? v : Number(v)));
      const bad = values.find((v) => !isEmpty(v) && Number.isNaN(typeof v === 'number' ? v : Number(v)));
      if (bad !== undefined) {
        throw new NodeOperationError(`Field "${spec.field}" has a value that is not a number: ${JSON.stringify(bad)}`, {
          hint: `"${spec.aggregation}" needs numbers. Use Count, Append or Concatenate for text.`,
        });
      }
      if (numbers.length === 0) return spec.aggregation === 'sum' ? 0 : null;
      if (spec.aggregation === 'sum') return numbers.reduce((a, b) => a + b, 0);
      if (spec.aggregation === 'average') return numbers.reduce((a, b) => a + b, 0) / numbers.length;
      return spec.aggregation === 'max' ? Math.max(...numbers) : Math.min(...numbers);
    }
  }
}

export default defineNode({
  description: {
    type: 'flowforge.summarize',
    displayName: 'Summarize',
    description: 'Sum, count, average, min, max or collect a field, optionally per group (like a pivot table).',
    icon: 'lucide:sigma',
    group: 'transform',
    version: 1,
    defaults: { name: 'Summarize', color: '#9b6dd7' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['sum', 'count', 'average', 'group by', 'pivot', 'total', 'statistics', 'min', 'max'],
  },
  properties: [
    {
      name: 'fieldsToSummarize',
      displayName: 'Fields To Summarize',
      type: 'fixedCollection',
      default: { values: [{ aggregation: 'count', field: '', includeEmpty: false, separateBy: ', ' }] },
      typeOptions: { multipleValues: true },
      options: [
        {
          name: 'values',
          displayName: 'Summary',
          values: [
            {
              name: 'aggregation',
              displayName: 'Aggregation',
              type: 'options',
              default: 'count',
              options: [
                { name: 'Append', value: 'append', description: 'List of all the values' },
                { name: 'Average', value: 'average' },
                { name: 'Concatenate', value: 'concatenate', description: 'All the values joined in one text' },
                { name: 'Count', value: 'count', description: 'How many items have a value' },
                { name: 'Count Unique', value: 'countUnique', description: 'How many different values' },
                { name: 'Max', value: 'max' },
                { name: 'Min', value: 'min' },
                { name: 'Sum', value: 'sum' },
              ],
            },
            { name: 'field', displayName: 'Field', type: 'string', default: '', placeholder: 'e.g. price', noDataExpression: true },
            { name: 'includeEmpty', displayName: 'Include Empty Values', type: 'boolean', default: false, displayOptions: { show: { aggregation: ['append', 'concatenate', 'count', 'countUnique'] } } },
            { name: 'separateBy', displayName: 'Separator', type: 'string', default: ', ', displayOptions: { show: { aggregation: ['concatenate'] } }, noDataExpression: true },
          ],
        },
      ],
    },
    { name: 'fieldsToSplitBy', displayName: 'Fields To Split By', type: 'string', default: '', placeholder: 'e.g. country, city', description: 'One result per different value of these fields (group by). Empty = one result for all items.' },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          name: 'outputFormat',
          displayName: 'Output Format',
          type: 'options',
          default: 'separateItems',
          options: [
            { name: 'Each Group In A Separate Item', value: 'separateItems' },
            { name: 'All Groups In A Single Item', value: 'singleItem' },
          ],
        },
        { name: 'skipEmptySplitFields', displayName: 'Ignore Items Without A Group', type: 'boolean', default: false, description: 'Skip items whose split field is empty.' },
        { name: 'continueIfFieldNotFound', displayName: 'Continue If Field Not Found', type: 'boolean', default: false },
        { name: 'disableDotNotation', displayName: 'Disable Dot Notation', type: 'boolean', default: false },
      ],
    },
  ],
  execute(ctx) {
    const items = ctx.getInputData();
    const options = ctx.getNodeParameter<JsonObject>('options', 0, {});
    const dot = options.disableDotNotation !== true;
    const summaries = ctx
      .getNodeParameter<Summary[]>('fieldsToSummarize.values', 0, [])
      .filter((s): s is Summary & { aggregation: Aggregation; field: string } => Boolean(s.field?.trim() && s.aggregation && s.aggregation in PREFIX))
      .map((s) => ({ ...s, field: s.field.trim() }));
    if (summaries.length === 0) throw new NodeOperationError('Add at least one field to summarize', { hint: 'Choose an aggregation and enter a field name, e.g. Sum of "price".' });
    const splitBy = fieldList(ctx.getNodeParameter('fieldsToSplitBy', 0, ''));

    if (items.length && options.continueIfFieldNotFound !== true) {
      for (const field of [...summaries.map((s) => s.field), ...splitBy]) {
        if (items.every((item) => readField(item.json, field, dot) === undefined)) {
          throw new NodeOperationError(`The field "${field}" does not exist in any item`, {
            hint: `Fields of the first item: ${Object.keys(items[0]!.json).join(', ') || 'none'}. Check the name (it is case-sensitive).`,
          });
        }
      }
    }

    interface Group {
      keys: unknown[];
      indexes: number[];
    }
    const groups = new Map<string, Group>();
    items.forEach((item, i) => {
      const keys = splitBy.map((field) => readField(item.json, field, dot));
      if (splitBy.length && options.skipEmptySplitFields === true && keys.some(isEmpty)) return;
      const id = stableKey(keys.map((k) => (k === undefined ? null : k)));
      let group = groups.get(id);
      if (!group) groups.set(id, (group = { keys, indexes: [] }));
      group.indexes.push(i);
    });
    // No split fields: always one result, even for an empty input.
    if (splitBy.length === 0 && groups.size === 0) groups.set('[]', { keys: [], indexes: [] });

    const results = [...groups.values()].map((group) => {
      const json: JsonObject = {};
      for (const spec of summaries) {
        const values = group.indexes.map((i) => readField(items[i]!.json, spec.field, dot));
        json[outputName(spec)] = summarize(spec, values) as JsonObject[string];
      }
      return { group, json };
    });

    if (options.outputFormat === 'singleItem') {
      const json: JsonObject = {};
      if (splitBy.length === 0) Object.assign(json, results[0]?.json ?? {});
      for (const { group, json: values } of splitBy.length ? results : []) {
        let target = json;
        group.keys.forEach((key, depth) => {
          const name = isEmpty(key) ? 'undefined' : typeof key === 'object' ? JSON.stringify(key) : String(key);
          if (depth === group.keys.length - 1) target[name] = values;
          else target = (target[name] ??= {}) as JsonObject;
        });
      }
      return [[{ json, ...(items.length ? { pairedItem: items.map((_item, i) => ({ item: i })) } : {}) }]];
    }

    const out: Item[] = results.map(({ group, json }) => {
      const head: JsonObject = {};
      splitBy.forEach((field, n) => (head[field.replace(/\./g, '_')] = (group.keys[n] === undefined ? null : group.keys[n]) as JsonObject[string]));
      return { json: { ...head, ...json }, ...(group.indexes.length ? { pairedItem: group.indexes.map((i) => ({ item: i })) } : {}) };
    });
    return [out];
  },
});
