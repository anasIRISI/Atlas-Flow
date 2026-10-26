import type { Item, JsonObject, NodeProperty } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { toCsv } from '../_shared/csv.js';
import { readField } from '../_shared/fields.js';
import { htmlTable } from '../transform/html.node.js';

const show = (...operation: string[]): NodeProperty['displayOptions'] => ({ show: { operation } });
const ENCODINGS = ['utf8', 'latin1', 'utf16le', 'ascii'] as const;
const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'text/plain': 'txt', 'text/csv': 'csv', 'text/html': 'html', 'application/json': 'json', 'application/zip': 'zip', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4',
};

export default defineNode({
  description: {
    type: 'flowforge.convertToFile',
    displayName: 'Convert to File',
    description: 'Turns items into a file: CSV, JSON, HTML table, text, or a file from a Base64 string.',
    icon: 'lucide:file-output',
    group: 'files',
    version: 1,
    defaults: { name: 'Convert to File', color: '#3aa981' },
    subtitle: '{{operation}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['csv', 'json', 'file', 'export', 'binary', 'spreadsheet', 'text', 'base64', 'download'],
  },
  properties: [
    {
      name: 'operation',
      displayName: 'Operation',
      type: 'options',
      default: 'csv',
      options: [
        { name: 'Convert to CSV', value: 'csv', description: 'All items in one CSV file' },
        { name: 'Convert to JSON', value: 'json' },
        { name: 'Convert to HTML', value: 'html', description: 'All items as a table in one HTML file' },
        { name: 'Convert to Text File', value: 'text', description: 'A text field of each item becomes a file' },
        { name: 'Move Base64 String to File', value: 'base64', description: 'A Base64 field of each item becomes a file' },
      ],
    },
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'options',
      default: 'once',
      options: [
        { name: 'All Items to One File', value: 'once' },
        { name: 'Each Item to Separate File', value: 'each' },
      ],
      displayOptions: show('json'),
    },
    { name: 'sourceProperty', displayName: 'Input Field', type: 'string', default: 'data', description: 'Field of the item that holds the text or Base64 string.', displayOptions: show('text', 'base64') },
    { name: 'binaryPropertyName', displayName: 'Put Output File in Field', type: 'string', default: 'data', description: 'Name of the binary property that will hold the file.' },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'fileName', displayName: 'File Name', type: 'string', default: '', placeholder: 'e.g. report.csv' },
        { name: 'delimiter', displayName: 'Delimiter (CSV)', type: 'string', default: ',', description: 'Use ; for Excel in many European countries.' },
        { name: 'headerRow', displayName: 'Header Row (CSV)', type: 'boolean', default: true },
        { name: 'bom', displayName: 'Add BOM For Excel (CSV)', type: 'boolean', default: false, description: 'Helps Excel read accents correctly.' },
        { name: 'pretty', displayName: 'Format Nicely (JSON)', type: 'boolean', default: true },
        { name: 'encoding', displayName: 'Encoding (Text)', type: 'options', default: 'utf8', options: ENCODINGS.map((e) => ({ name: e, value: e })) },
        { name: 'mimeType', displayName: 'MIME Type (Base64)', type: 'string', default: '', placeholder: 'e.g. image/png' },
      ],
    },
  ],
  async execute(ctx) {
    const items = ctx.getInputData();
    const operation = String(ctx.getNodeParameter('operation', 0, 'csv'));
    const property0 = String(ctx.getNodeParameter('binaryPropertyName', 0, 'data') || 'data');
    const options0 = ctx.getNodeParameter<JsonObject>('options', 0, {});
    const allPaired = items.length ? { pairedItem: items.map((_item, i) => ({ item: i })) } : {};
    const single = async (data: Buffer, fallbackName: string, mimeType: string): Promise<Item[][]> => {
      const ref = await ctx.helpers.prepareBinaryData(data, String(options0.fileName || fallbackName), mimeType);
      return [[{ json: { fileName: ref.fileName ?? fallbackName, mimeType: ref.mimeType, fileSize: ref.fileSize, itemCount: items.length }, binary: { [property0]: ref }, ...allPaired }]];
    };

    if (operation === 'csv') {
      const csv = toCsv(items.map((item) => item.json), { delimiter: String(options0.delimiter || ','), headerRow: options0.headerRow !== false });
      return single(Buffer.from((options0.bom === true ? '﻿' : '') + csv, 'utf8'), 'file.csv', 'text/csv');
    }
    if (operation === 'html') {
      const table = htmlTable(items.map((item) => item.json));
      const page = `<!doctype html>\n<html><head><meta charset="utf-8"><title>${String(options0.fileName || 'Table').replace(/[<>&]/g, '')}</title></head>\n<body>\n${table}\n</body></html>\n`;
      return single(Buffer.from(page, 'utf8'), 'file.html', 'text/html');
    }
    if (operation === 'json' && ctx.getNodeParameter<string>('mode', 0, 'once') !== 'each') {
      const text = JSON.stringify(items.map((item) => item.json), null, options0.pretty === false ? undefined : 2);
      return single(Buffer.from(text, 'utf8'), 'file.json', 'application/json');
    }

    const out = await ctx.forEachItem(async (item, i) => {
      const options = ctx.getNodeParameter<JsonObject>('options', i, {});
      const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data');
      let data: Buffer;
      let name: string;
      let mimeType: string;
      if (operation === 'json') {
        data = Buffer.from(JSON.stringify(item.json, null, options.pretty === false ? undefined : 2), 'utf8');
        name = 'file.json';
        mimeType = 'application/json';
      } else {
        const field = String(ctx.getNodeParameter('sourceProperty', i, 'data') || 'data');
        const value = readField(item.json, field);
        if (value === undefined || value === null) {
          throw new NodeOperationError(`Item ${i} has no field "${field}"`, { itemIndex: i, hint: `Fields of this item: ${Object.keys(item.json).join(', ') || 'none'}.` });
        }
        if (operation === 'text') {
          const encoding = ENCODINGS.includes(options.encoding as 'utf8') ? (options.encoding as BufferEncoding) : 'utf8';
          data = Buffer.from(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value), encoding);
          name = 'file.txt';
          mimeType = 'text/plain';
        } else {
          const text = String(value).replace(/^data:([^;,]+)?(;base64)?,/, '').replace(/\s+/g, '');
          if (!text || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(text)) {
            throw new NodeOperationError(`Field "${field}" of item ${i} is not a Base64 string`, { itemIndex: i, hint: 'Base64 uses letters, digits, + and / only.' });
          }
          data = Buffer.from(text, 'base64');
          // MIME type: the option, else the one of a data: URL, else guessed from the file name.
          mimeType = String(options.mimeType || /^data:([^;,]+)/.exec(String(value))?.[1] || '');
          name = `file${EXT_BY_MIME[mimeType] ? `.${EXT_BY_MIME[mimeType]}` : ''}`;
        }
      }
      const ref = await ctx.helpers.prepareBinaryData(data, String(options.fileName || name), mimeType || undefined);
      return { json: item.json, binary: { ...(item.binary ?? {}), [property]: ref } };
    });
    return [out];
  },
});
