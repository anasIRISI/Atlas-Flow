import type { Item, JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { cloneJson, fieldList, isPlainObject, leafName, readField, removeField, writeField } from '../_shared/fields.js';

export default defineNode({
  description: {
    type: 'flowforge.splitOut',
    displayName: 'Split Out',
    description: 'Turns a list inside each item into separate items (the opposite of Aggregate).',
    icon: 'lucide:split',
    group: 'transform',
    version: 1,
    defaults: { name: 'Split Out', color: '#9b6dd7' },
    subtitle: '{{fieldToSplitOut}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['split', 'list', 'array', 'explode', 'unwind', 'flatten', 'item lists'],
  },
  properties: [
    {
      name: 'fieldToSplitOut',
      displayName: 'Fields To Split Out',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'e.g. items',
      description: 'Name of the field that holds the list. Several fields: separate with commas (they are split side by side).',
    },
    {
      name: 'include',
      displayName: 'Include',
      type: 'options',
      default: 'noOtherFields',
      options: [
        { name: 'No Other Fields', value: 'noOtherFields' },
        { name: 'All Other Fields', value: 'allOtherFields' },
        { name: 'Selected Other Fields', value: 'selectedOtherFields' },
      ],
    },
    { name: 'fieldsToInclude', displayName: 'Fields To Include', type: 'string', default: '', placeholder: 'e.g. id, customer.name', displayOptions: { show: { include: ['selectedOtherFields'] } } },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'destinationFieldName', displayName: 'Destination Field Name', type: 'string', default: '', description: 'Field to put each element in (default: the name of the split field).' },
        { name: 'disableDotNotation', displayName: 'Disable Dot Notation', type: 'boolean', default: false },
        { name: 'includeBinary', displayName: 'Include Binary', type: 'boolean', default: false, description: 'Copy the binary data of the item to every new item.' },
      ],
    },
  ],
  async execute(ctx) {
    const out = await ctx.forEachItem((item, i) => {
      const fields = fieldList(ctx.getNodeParameter('fieldToSplitOut', i, ''));
      if (fields.length === 0) throw new NodeOperationError('"Fields To Split Out" is empty', { hint: 'Enter the name of the field that holds a list, e.g. "items".' });
      const include = String(ctx.getNodeParameter('include', i, 'noOtherFields'));
      const options = ctx.getNodeParameter<JsonObject>('options', i, {});
      const dot = options.disableDotNotation !== true;
      const destinations = fieldList(options.destinationFieldName);
      if (destinations.length && destinations.length !== fields.length) {
        throw new NodeOperationError('Give one destination field name per field to split out', { itemIndex: i });
      }

      const lists = fields.map((field) => {
        const value = readField(item.json, field, dot);
        if (value === undefined) {
          throw new NodeOperationError(`Field "${field}" was not found in item ${i}`, {
            itemIndex: i,
            hint: `Fields of this item: ${Object.keys(item.json).join(', ') || 'none'}. Check the name (it is case-sensitive).`,
          });
        }
        // A single value behaves like a list with one element; an object is split into its values.
        if (Array.isArray(value)) return value;
        return isPlainObject(value) ? Object.values(value) : [value];
      });

      const length = Math.max(...lists.map((l) => l.length));
      const result: Item[] = [];
      for (let n = 0; n < length; n++) {
        let json: JsonObject = {};
        if (include === 'allOtherFields') {
          json = cloneJson(item.json);
          for (const field of fields) removeField(json, field, dot);
        } else if (include === 'selectedOtherFields') {
          for (const field of fieldList(ctx.getNodeParameter('fieldsToInclude', i, ''))) {
            const value = readField(item.json, field, dot);
            if (value !== undefined) writeField(json, field, cloneJson(value), dot);
          }
        }
        const single = fields.length === 1 && include === 'noOtherFields' && destinations.length === 0;
        fields.forEach((field, f) => {
          const element = lists[f]![n];
          if (element === undefined) return;
          // One field, nothing else kept: an object element becomes the item itself.
          if (single && isPlainObject(element)) json = { ...json, ...cloneJson(element) };
          else writeField(json, destinations[f] ?? (include === 'noOtherFields' ? leafName(field, dot) : field), cloneJson(element), dot);
        });
        result.push({ json, ...(options.includeBinary === true && item.binary ? { binary: item.binary } : {}), pairedItem: { item: i } });
      }
      return result;
    });
    return [out];
  },
});
