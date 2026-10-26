import { getPath } from '../../engine/params.js';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';

interface SortField {
  fieldName: string;
  order: 'ascending' | 'descending';
}

const isMissing = (v: unknown) => v === undefined || v === null;

/** Compares two present values (missing values are handled by the caller: always last). */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export default defineNode({
  description: {
    type: 'flowforge.sort',
    displayName: 'Sort',
    description: 'Sorts items by one or more fields, or in random order.',
    icon: 'lucide:arrow-down-wide-narrow',
    group: 'transform',
    version: 1,
    defaults: { name: 'Sort', color: '#9b6dd7' },
    subtitle: '{{type}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['order', 'shuffle', 'random'],
  },
  properties: [
    {
      name: 'type',
      displayName: 'Type',
      type: 'options',
      default: 'simple',
      options: [
        { name: 'Simple', value: 'simple' },
        { name: 'Random', value: 'random' },
      ],
    },
    {
      name: 'sortFieldsUi',
      displayName: 'Fields To Sort By',
      type: 'fixedCollection',
      default: { sortField: [{ fieldName: '', order: 'ascending' }] },
      typeOptions: { multipleValues: true },
      displayOptions: { show: { type: ['simple'] } },
      options: [
        {
          name: 'sortField',
          displayName: 'Field To Sort By',
          values: [
            { name: 'fieldName', displayName: 'Field Name', type: 'string', default: '', placeholder: 'e.g. age' },
            {
              name: 'order',
              displayName: 'Order',
              type: 'options',
              default: 'ascending',
              options: [
                { name: 'Ascending', value: 'ascending' },
                { name: 'Descending', value: 'descending' },
              ],
            },
          ],
        },
      ],
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      displayOptions: { show: { type: ['simple'] } },
      options: [
        {
          name: 'disableDotNotation',
          displayName: 'Disable Dot Notation',
          type: 'boolean',
          default: false,
          description: 'Treat "a.b" as a field name instead of the nested field b inside a.',
        },
      ],
    },
  ],
  execute(ctx) {
    const items = [...ctx.getInputData()];
    if (ctx.getNodeParameter('type', 0) === 'random') {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j]!, items[i]!];
      }
      return [items];
    }
    const fields = ctx.getNodeParameter<SortField[]>('sortFieldsUi.sortField', 0, []).filter((f) => f.fieldName);
    if (fields.length === 0) throw new NodeOperationError('Add at least one field to sort by');
    const dot = !ctx.getNodeParameter<boolean>('options.disableDotNotation', 0, false);
    const read = (json: Record<string, unknown>, field: string) => (dot ? getPath(json, field) : json[field]);
    items.sort((a, b) => {
      for (const field of fields) {
        const va = read(a.json, field.fieldName);
        const vb = read(b.json, field.fieldName);
        if (isMissing(va) || isMissing(vb)) {
          if (isMissing(va) && isMissing(vb)) continue;
          return isMissing(va) ? 1 : -1; // items without the field go last, whatever the order
        }
        const diff = compareValues(va, vb);
        if (diff !== 0) return field.order === 'descending' ? -diff : diff;
      }
      return 0;
    });
    return [items];
  },
});
