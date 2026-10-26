import type { Item, JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { cloneJson, fieldList, leafName, readField, removeField } from '../_shared/fields.js';

interface FieldToAggregate {
  fieldToAggregate?: string;
  renameField?: boolean;
  outputFieldName?: string;
}

export default defineNode({
  description: {
    type: 'flowforge.aggregate',
    displayName: 'Aggregate',
    description: 'Combines a field of many items into one list in a single item (the opposite of Split Out).',
    icon: 'lucide:combine',
    group: 'transform',
    version: 1,
    defaults: { name: 'Aggregate', color: '#9b6dd7' },
    subtitle: '{{aggregate}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['combine', 'list', 'group', 'collect', 'array', 'merge items'],
  },
  properties: [
    {
      name: 'aggregate',
      displayName: 'Aggregate',
      type: 'options',
      default: 'aggregateIndividualFields',
      options: [
        { name: 'Individual Fields', value: 'aggregateIndividualFields', description: 'One list per chosen field' },
        { name: 'All Item Data (Into a Single List)', value: 'aggregateAllItemData', description: 'One list containing every item' },
      ],
    },
    {
      name: 'fieldsToAggregate',
      displayName: 'Fields To Aggregate',
      type: 'fixedCollection',
      default: { fieldToAggregate: [{ fieldToAggregate: '', renameField: false, outputFieldName: '' }] },
      typeOptions: { multipleValues: true },
      displayOptions: { show: { aggregate: ['aggregateIndividualFields'] } },
      options: [
        {
          name: 'fieldToAggregate',
          displayName: 'Field',
          values: [
            { name: 'fieldToAggregate', displayName: 'Input Field Name', type: 'string', default: '', placeholder: 'e.g. email', noDataExpression: true },
            { name: 'renameField', displayName: 'Rename Field', type: 'boolean', default: false },
            { name: 'outputFieldName', displayName: 'Output Field Name', type: 'string', default: '', displayOptions: { show: { renameField: [true] } }, noDataExpression: true },
          ],
        },
      ],
    },
    { name: 'destinationFieldName', displayName: 'Put Output In Field', type: 'string', default: 'data', displayOptions: { show: { aggregate: ['aggregateAllItemData'] } } },
    {
      name: 'include',
      displayName: 'Include',
      type: 'options',
      default: 'allFields',
      displayOptions: { show: { aggregate: ['aggregateAllItemData'] } },
      options: [
        { name: 'All Fields', value: 'allFields' },
        { name: 'Specified Fields', value: 'specifiedFields' },
        { name: 'All Fields Except', value: 'allFieldsExcept' },
      ],
    },
    { name: 'fieldsToInclude', displayName: 'Fields To Include', type: 'string', default: '', placeholder: 'e.g. name, email', displayOptions: { show: { aggregate: ['aggregateAllItemData'], include: ['specifiedFields'] } } },
    { name: 'fieldsToExclude', displayName: 'Fields To Exclude', type: 'string', default: '', placeholder: 'e.g. password', displayOptions: { show: { aggregate: ['aggregateAllItemData'], include: ['allFieldsExcept'] } } },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'disableDotNotation', displayName: 'Disable Dot Notation', type: 'boolean', default: false, description: 'Treat "a.b" as a field name instead of the nested field b inside a.' },
        { name: 'mergeLists', displayName: 'Merge Lists', type: 'boolean', default: false, description: 'When the field already holds lists, join them into one list instead of a list of lists.' },
        { name: 'keepMissing', displayName: 'Keep Missing And Null Values', type: 'boolean', default: false, description: 'Add null for items that do not have the field.' },
      ],
    },
  ],
  execute(ctx) {
    const items = ctx.getInputData();
    const options = ctx.getNodeParameter<JsonObject>('options', 0, {});
    const dot = options.disableDotNotation !== true;
    const paired = items.map((_item, i) => ({ item: i }));
    const output = (json: JsonObject): Item[][] => [[{ json, ...(paired.length ? { pairedItem: paired } : {}) }]];

    if (ctx.getNodeParameter('aggregate', 0) === 'aggregateAllItemData') {
      const destination = String(ctx.getNodeParameter('destinationFieldName', 0, 'data') || 'data');
      const include = String(ctx.getNodeParameter('include', 0, 'allFields'));
      const chosen = fieldList(ctx.getNodeParameter(include === 'specifiedFields' ? 'fieldsToInclude' : 'fieldsToExclude', 0, ''));
      if (include !== 'allFields' && chosen.length === 0) {
        throw new NodeOperationError(include === 'specifiedFields' ? 'No fields to include' : 'No fields to exclude', { hint: 'Enter field names separated by commas.' });
      }
      const list = items.map((item) => {
        if (include === 'allFields') return item.json;
        if (include === 'specifiedFields') {
          const picked: JsonObject = {};
          for (const field of chosen) {
            const value = readField(item.json, field, dot);
            if (value !== undefined) picked[field] = value as JsonObject[string];
          }
          return picked;
        }
        const rest = cloneJson(item.json);
        for (const field of chosen) removeField(rest, field, dot);
        return rest;
      });
      return output({ [destination]: list });
    }

    const fields = ctx.getNodeParameter<FieldToAggregate[]>('fieldsToAggregate.fieldToAggregate', 0, []).filter((f) => f.fieldToAggregate?.trim());
    if (fields.length === 0) throw new NodeOperationError('Add at least one field to aggregate', { hint: 'Enter the name of a field of the input items, e.g. "email".' });
    const json: JsonObject = {};
    for (const spec of fields) {
      const field = spec.fieldToAggregate!.trim();
      const name = spec.renameField && spec.outputFieldName?.trim() ? spec.outputFieldName.trim() : leafName(field, dot);
      if (name in json) throw new NodeOperationError(`Two fields would be written to "${name}"`, { hint: 'Rename one of them with "Rename Field".' });
      const values: unknown[] = [];
      for (const item of items) {
        const value = readField(item.json, field, dot);
        if (value === undefined || value === null) {
          if (options.keepMissing === true) values.push(null);
        } else if (options.mergeLists === true && Array.isArray(value)) values.push(...value);
        else values.push(value);
      }
      json[name] = values as JsonObject[string];
    }
    return output(json);
  },
});
