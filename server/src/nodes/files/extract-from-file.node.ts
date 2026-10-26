import type { Item, JsonObject, NodeProperty } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { parseCsv } from '../_shared/csv.js';
import { isPlainObject, writeField } from '../_shared/fields.js';

const show = (...operation: string[]): NodeProperty['displayOptions'] => ({ show: { operation } });
const ENCODINGS = ['utf8', 'latin1', 'utf16le', 'ascii'] as const;

export default defineNode({
  description: {
    type: 'flowforge.extractFromFile',
    displayName: 'Extract from File',
    description: 'Reads a file of the item: CSV rows or JSON as items, text, or the file as a Base64 string.',
    icon: 'lucide:file-input',
    group: 'files',
    version: 1,
    defaults: { name: 'Extract from File', color: '#3aa981' },
    subtitle: '{{operation}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['csv', 'json', 'file', 'import', 'binary', 'spreadsheet', 'text', 'base64', 'parse', 'read'],
  },
  properties: [
    {
      name: 'operation',
      displayName: 'Operation',
      type: 'options',
      default: 'csv',
      options: [
        { name: 'Extract From CSV', value: 'csv', description: 'One item per row' },
        { name: 'Extract From JSON', value: 'json', description: 'One item per element of the list' },
        { name: 'Extract From Text File', value: 'text', description: 'The text in a field' },
        { name: 'Move File to Base64 String', value: 'binaryToProperty', description: 'The file as Base64 in a field' },
      ],
    },
    { name: 'binaryPropertyName', displayName: 'Input Binary Field', type: 'string', default: 'data', description: 'Name of the binary property that holds the file.' },
    { name: 'destinationKey', displayName: 'Destination Output Field', type: 'string', default: 'data', displayOptions: show('text', 'binaryToProperty') },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'delimiter', displayName: 'Delimiter (CSV)', type: 'string', default: '', placeholder: 'empty = detect , ; tab |' },
        { name: 'headerRow', displayName: 'Header Row (CSV)', type: 'boolean', default: true, description: 'Off: each row becomes { row: [...] }.' },
        { name: 'readAsString', displayName: 'Read As Text (CSV)', type: 'boolean', default: false, description: 'Keep numbers and true/false as text.' },
        { name: 'encoding', displayName: 'Encoding', type: 'options', default: 'utf8', options: ENCODINGS.map((e) => ({ name: e, value: e })) },
        { name: 'keepSource', displayName: 'Keep Input Fields', type: 'boolean', default: false, description: 'Text / Base64: keep the other fields of the item.' },
      ],
    },
  ],
  async execute(ctx) {
    const out = await ctx.forEachItem(async (item, i): Promise<Item[] | Item> => {
      const operation = String(ctx.getNodeParameter('operation', i, 'csv'));
      const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data');
      const options = ctx.getNodeParameter<JsonObject>('options', i, {});
      const encoding = ENCODINGS.includes(options.encoding as 'utf8') ? (options.encoding as BufferEncoding) : 'utf8';
      const ref = item.binary?.[property];
      if (!ref) {
        throw new NodeOperationError(`Item ${i} has no file in "${property}"`, {
          itemIndex: i,
          hint: `Binary properties of this item: ${Object.keys(item.binary ?? {}).join(', ') || 'none'}. Set "Input Binary Field" to one of them.`,
        });
      }
      const data = await ctx.helpers.getBinaryDataBuffer(i, property);
      const name = ref.fileName ? `"${ref.fileName}"` : 'The file';

      if (operation === 'binaryToProperty' || operation === 'text') {
        const key = String(ctx.getNodeParameter('destinationKey', i, 'data') || 'data');
        const json: JsonObject = options.keepSource === true ? structuredClone(item.json) : {};
        writeField(json, key, operation === 'text' ? data.toString(encoding).replace(/^﻿/, '') : data.toString('base64'));
        return { json };
      }
      const text = data.toString(encoding);
      if (operation === 'json') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text.replace(/^﻿/, ''));
        } catch (err) {
          throw new NodeOperationError(`${name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { itemIndex: i });
        }
        return (Array.isArray(parsed) ? parsed : [parsed]).map((element) => ({ json: isPlainObject(element) ? element : { data: element as JsonObject[string] }, pairedItem: { item: i } }));
      }
      try {
        return parseCsv(text, { delimiter: String(options.delimiter ?? ''), headerRow: options.headerRow !== false, readAsString: options.readAsString === true }).map((json) => ({ json, pairedItem: { item: i } }));
      } catch (err) {
        throw new NodeOperationError(`${name} is not valid CSV: ${err instanceof Error ? err.message : String(err)}`, { itemIndex: i, hint: 'Check the quotes, or set the delimiter in the options.' });
      }
    });
    return [out];
  },
});
