import { Builder, Parser } from 'xml2js';
import type { JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { readField } from '../_shared/fields.js';

export default defineNode({
  description: {
    type: 'flowforge.xml',
    displayName: 'XML',
    description: 'Converts XML text to JSON, or JSON to XML.',
    icon: 'lucide:file-code',
    group: 'transform',
    version: 1,
    defaults: { name: 'XML', color: '#9b6dd7' },
    subtitle: '{{mode}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['xml', 'json', 'convert', 'parse', 'soap', 'rss'],
  },
  properties: [
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'options',
      default: 'xmlToJson',
      options: [
        { name: 'XML to JSON', value: 'xmlToJson', description: 'Read XML text from a field' },
        { name: 'JSON to XML', value: 'jsonToXml', description: 'Write the item as XML text' },
      ],
    },
    {
      name: 'dataPropertyName',
      displayName: 'Property Name',
      type: 'string',
      default: 'data',
      description: 'XML to JSON: the field that contains the XML. JSON to XML: the field the XML is written to.',
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'explicitArray', displayName: 'Always Use Lists (to JSON)', type: 'boolean', default: false, description: 'Off: a list only when a tag appears several times.' },
        { name: 'explicitRoot', displayName: 'Keep Root Tag (to JSON)', type: 'boolean', default: true },
        { name: 'ignoreAttrs', displayName: 'Ignore Attributes (to JSON)', type: 'boolean', default: false },
        { name: 'mergeAttrs', displayName: 'Merge Attributes (to JSON)', type: 'boolean', default: true, description: 'Attributes become normal fields next to the child tags.' },
        { name: 'normalizeTags', displayName: 'Lowercase Tag Names (to JSON)', type: 'boolean', default: false },
        { name: 'trim', displayName: 'Trim Text (to JSON)', type: 'boolean', default: true },
        { name: 'attrkey', displayName: 'Attribute Key', type: 'string', default: '$', description: 'Field holding the attributes of a tag.' },
        { name: 'charkey', displayName: 'Text Key', type: 'string', default: '_', description: 'Field holding the text of a tag that also has attributes.' },
        { name: 'rootName', displayName: 'Root Tag Name (to XML)', type: 'string', default: 'root', description: 'Used when the item has more than one top-level field.' },
        { name: 'headless', displayName: 'No XML Declaration (to XML)', type: 'boolean', default: false },
        { name: 'cdata', displayName: 'Use CDATA When Needed (to XML)', type: 'boolean', default: false },
        { name: 'pretty', displayName: 'Indent (to XML)', type: 'boolean', default: true },
      ],
    },
  ],
  async execute(ctx) {
    const out = await ctx.forEachItem(async (item, i) => {
      const mode = String(ctx.getNodeParameter('mode', i, 'xmlToJson'));
      const property = String(ctx.getNodeParameter('dataPropertyName', i, 'data') || 'data');
      const o = ctx.getNodeParameter<JsonObject>('options', i, {});
      const attrkey = String(o.attrkey || '$');
      const charkey = String(o.charkey || '_');

      if (mode === 'jsonToXml') {
        const builder = new Builder({
          attrkey,
          charkey,
          rootName: String(o.rootName || 'root'),
          headless: o.headless === true,
          cdata: o.cdata === true,
          renderOpts: { pretty: o.pretty !== false, indent: '  ', newline: '\n' },
        });
        try {
          return { json: { [property]: builder.buildObject(item.json) } };
        } catch (err) {
          throw new NodeOperationError(`Item ${i} cannot be written as XML: ${err instanceof Error ? err.message : String(err)}`, {
            itemIndex: i,
            hint: 'Field names must be valid XML tag names (no spaces, not starting with a digit).',
          });
        }
      }

      const xml = readField(item.json, property);
      if (typeof xml !== 'string' || !xml.trim()) {
        throw new NodeOperationError(xml === undefined ? `Item ${i} has no field "${property}"` : `Field "${property}" of item ${i} does not contain XML text`, {
          itemIndex: i,
          hint: `"Property Name" must name the field with the XML. Fields of this item: ${Object.keys(item.json).join(', ') || 'none'}.`,
        });
      }
      const parser = new Parser({
        attrkey,
        charkey,
        explicitArray: o.explicitArray === true,
        explicitRoot: o.explicitRoot !== false,
        ignoreAttrs: o.ignoreAttrs === true,
        mergeAttrs: o.mergeAttrs !== false,
        normalizeTags: o.normalizeTags === true,
        trim: o.trim !== false,
      });
      try {
        const parsed = (await parser.parseStringPromise(xml)) as unknown;
        // Plain JSON only (xml2js objects have no prototype).
        return { json: (parsed && typeof parsed === 'object' ? JSON.parse(JSON.stringify(parsed)) : { value: parsed }) as JsonObject };
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).split('\n').slice(0, 3).join(' · ');
        throw new NodeOperationError(`The XML of item ${i} is not valid: ${message}`, { itemIndex: i, hint: 'Check that every tag is closed and that there is a single root tag.' });
      }
    });
    return [out];
  },
});
