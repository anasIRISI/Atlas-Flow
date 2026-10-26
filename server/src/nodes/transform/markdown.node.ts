import { marked } from 'marked';
import TurndownService from 'turndown';
import type { JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { writeField } from '../_shared/fields.js';

export default defineNode({
  description: {
    type: 'flowforge.markdown',
    displayName: 'Markdown',
    description: 'Converts Markdown to HTML, or HTML to Markdown.',
    icon: 'lucide:file-type',
    group: 'transform',
    version: 1,
    defaults: { name: 'Markdown', color: '#9b6dd7' },
    subtitle: '{{mode}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['markdown', 'html', 'convert', 'md', 'text'],
  },
  properties: [
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'options',
      default: 'markdownToHtml',
      options: [
        { name: 'Markdown to HTML', value: 'markdownToHtml' },
        { name: 'HTML to Markdown', value: 'htmlToMarkdown' },
      ],
    },
    { name: 'markdown', displayName: 'Markdown', type: 'string', default: '', typeOptions: { rows: 6 }, placeholder: '# Title\n\nSome **bold** text', displayOptions: { show: { mode: ['markdownToHtml'] } } },
    { name: 'html', displayName: 'HTML', type: 'string', default: '', typeOptions: { rows: 6 }, placeholder: '<h1>Title</h1><p>Some <b>bold</b> text</p>', displayOptions: { show: { mode: ['htmlToMarkdown'] } } },
    { name: 'destinationKey', displayName: 'Destination Key', type: 'string', default: 'data', description: 'Field the result is written to.' },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'breaks', displayName: 'Line Breaks (to HTML)', type: 'boolean', default: false, description: 'A single line break becomes <br>.' },
        { name: 'gfm', displayName: 'Tables And Strikethrough (to HTML)', type: 'boolean', default: true },
        {
          name: 'bulletMarker',
          displayName: 'Bullet Marker (to Markdown)',
          type: 'options',
          default: '-',
          options: [
            { name: '-', value: '-' },
            { name: '*', value: '*' },
            { name: '+', value: '+' },
          ],
        },
        {
          name: 'codeBlockStyle',
          displayName: 'Code Block Style (to Markdown)',
          type: 'options',
          default: 'fenced',
          options: [
            { name: 'Fenced (```)', value: 'fenced' },
            { name: 'Indented', value: 'indented' },
          ],
        },
        { name: 'includeInputFields', displayName: 'Include Input Fields', type: 'boolean', default: true },
      ],
    },
  ],
  async execute(ctx) {
    const out = await ctx.forEachItem(async (item, i) => {
      const mode = String(ctx.getNodeParameter('mode', i, 'markdownToHtml'));
      const key = String(ctx.getNodeParameter('destinationKey', i, 'data') || 'data');
      const o = ctx.getNodeParameter<JsonObject>('options', i, {});
      const source = ctx.getNodeParameter(mode === 'markdownToHtml' ? 'markdown' : 'html', i, '');
      if (source !== null && source !== undefined && typeof source === 'object') {
        throw new NodeOperationError(`The ${mode === 'markdownToHtml' ? 'Markdown' : 'HTML'} of item ${i} is not text`, { itemIndex: i, hint: 'Point to a text field, e.g. {{ $json.content }}.' });
      }
      const text = String(source ?? '');
      let result: string;
      if (mode === 'markdownToHtml') result = (await marked.parse(text, { gfm: o.gfm !== false, breaks: o.breaks === true })).trim();
      else {
        const service = new TurndownService({
          headingStyle: 'atx',
          hr: '---',
          bulletListMarker: (['-', '*', '+'].includes(String(o.bulletMarker)) ? o.bulletMarker : '-') as '-',
          codeBlockStyle: o.codeBlockStyle === 'indented' ? 'indented' : 'fenced',
          emDelimiter: '*',
        });
        result = service.turndown(text);
      }
      const json: JsonObject = o.includeInputFields === false ? {} : structuredClone(item.json);
      writeField(json, key, result);
      return { json };
    });
    return [out];
  },
});
