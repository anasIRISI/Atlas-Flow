import * as cheerio from 'cheerio';
import { escapeHtml, type JsonObject, type NodeProperty } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { readField } from '../_shared/fields.js';

interface Extraction {
  key?: string;
  cssSelector?: string;
  returnValue?: 'text' | 'html' | 'attribute' | 'value';
  attribute?: string;
  returnArray?: boolean;
}

const show = (...operation: string[]): NodeProperty['displayOptions'] => ({ show: { operation } });
const clean = (text: string) => text.replace(/[ \t\f\v]*\n\s*/g, '\n').replace(/[ \t\f\v]+/g, ' ');
const cell = (value: unknown) => escapeHtml(value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));

const TABLE = 'border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:14px';
const TH = 'border:1px solid #d5d8e0;background:#f1f3f8;padding:8px 12px;text-align:left';
const TD = 'border:1px solid #d5d8e0;padding:8px 12px;vertical-align:top';

/** All items as one HTML table (inline styles: also fine inside an email). */
export function htmlTable(rows: JsonObject[], options: { capitalize?: boolean; caption?: string; plain?: boolean } = {}): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const style = (css: string) => (options.plain ? '' : ` style="${css}"`);
  const label = (name: string) => (options.capitalize ? name.charAt(0).toUpperCase() + name.slice(1) : name);
  const head = `<tr>${columns.map((c) => `<th${style(TH)}>${escapeHtml(label(c))}</th>`).join('')}</tr>`;
  const body = rows.map((row) => `<tr>${columns.map((c) => `<td${style(TD)}>${cell(row[c])}</td>`).join('')}</tr>`).join('\n');
  const caption = options.caption ? `<caption>${escapeHtml(options.caption)}</caption>\n` : '';
  return `<table${style(TABLE)}>\n${caption}<thead>${head}</thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

export default defineNode({
  description: {
    type: 'flowforge.html',
    displayName: 'HTML',
    description: 'Extract values from HTML with CSS selectors, build HTML from a template, or turn items into a table.',
    icon: 'lucide:code-xml',
    group: 'transform',
    version: 1,
    defaults: { name: 'HTML', color: '#9b6dd7' },
    subtitle: '{{operation}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['html', 'extract', 'scrape', 'css selector', 'cheerio', 'template', 'table', 'parse'],
  },
  properties: [
    {
      name: 'operation',
      displayName: 'Operation',
      type: 'options',
      default: 'extractHtmlContent',
      options: [
        { name: 'Extract HTML Content', value: 'extractHtmlContent', description: 'Read values with CSS selectors' },
        { name: 'Generate HTML Template', value: 'generateHtmlTemplate', description: 'Write HTML with {{ expressions }}' },
        { name: 'Convert to HTML Table', value: 'convertToHtmlTable', description: 'All items as one table' },
      ],
    },
    {
      name: 'sourceData',
      displayName: 'Source Data',
      type: 'options',
      default: 'json',
      options: [
        { name: 'JSON', value: 'json', description: 'A field of the item contains the HTML' },
        { name: 'Binary', value: 'binary', description: 'A file of the item contains the HTML' },
      ],
      displayOptions: show('extractHtmlContent'),
    },
    {
      name: 'dataPropertyName',
      displayName: 'Field With The HTML',
      type: 'string',
      default: 'data',
      description: 'Name of the JSON field (or binary property) that holds the HTML.',
      displayOptions: show('extractHtmlContent'),
    },
    {
      name: 'extractionValues',
      displayName: 'Extraction Values',
      type: 'fixedCollection',
      default: { values: [{ key: '', cssSelector: '', returnValue: 'text', attribute: '', returnArray: false }] },
      typeOptions: { multipleValues: true },
      displayOptions: show('extractHtmlContent'),
      options: [
        {
          name: 'values',
          displayName: 'Value',
          values: [
            { name: 'key', displayName: 'Key', type: 'string', default: '', placeholder: 'e.g. title', description: 'Field of the output the value is saved in.', noDataExpression: true },
            { name: 'cssSelector', displayName: 'CSS Selector', type: 'string', default: '', placeholder: 'e.g. h1, .price, a[href], #main p', noDataExpression: true },
            {
              name: 'returnValue',
              displayName: 'Return Value',
              type: 'options',
              default: 'text',
              options: [
                { name: 'Text', value: 'text' },
                { name: 'HTML', value: 'html' },
                { name: 'Attribute', value: 'attribute', description: 'e.g. href, src' },
                { name: 'Value', value: 'value', description: 'Value of an input, select or textarea' },
              ],
            },
            { name: 'attribute', displayName: 'Attribute', type: 'string', default: '', placeholder: 'e.g. href', displayOptions: { show: { returnValue: ['attribute'] } }, noDataExpression: true },
            { name: 'returnArray', displayName: 'Return Array', type: 'boolean', default: false, description: 'On: every match as a list. Off: the first match only.' },
          ],
        },
      ],
    },
    {
      name: 'html',
      displayName: 'HTML Template',
      type: 'code',
      default: '<h1>Hello {{ $json.name }}!</h1>\n<p>Generated at {{ $now.toFormat("HH:mm") }}</p>',
      typeOptions: { language: 'html', rows: 10 },
      description: '{{ }} expressions are filled in for every item.',
      noDataExpression: true,
      displayOptions: show('generateHtmlTemplate'),
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'trimValues', displayName: 'Trim Values (Extract)', type: 'boolean', default: true },
        { name: 'cleanUpText', displayName: 'Clean Up Text (Extract)', type: 'boolean', default: true, description: 'Collapse repeated spaces and line breaks.' },
        { name: 'capitalize', displayName: 'Capitalize Headers (Table)', type: 'boolean', default: false },
        { name: 'caption', displayName: 'Caption (Table)', type: 'string', default: '' },
        { name: 'customStyling', displayName: 'Plain Table Without Styles (Table)', type: 'boolean', default: false },
        { name: 'outputFieldName', displayName: 'Output Field Name (Template, Table)', type: 'string', default: '' },
      ],
    },
  ],
  async execute(ctx) {
    const operation = String(ctx.getNodeParameter('operation', 0, 'extractHtmlContent'));

    if (operation === 'convertToHtmlTable') {
      const items = ctx.getInputData();
      const options = ctx.getNodeParameter<JsonObject>('options', 0, {});
      const table = htmlTable(items.map((item) => item.json), { capitalize: options.capitalize === true, caption: String(options.caption ?? ''), plain: options.customStyling === true });
      const field = String(options.outputFieldName || 'table');
      return [[{ json: { [field]: table }, ...(items.length ? { pairedItem: items.map((_item, i) => ({ item: i })) } : {}) }]];
    }

    const out = await ctx.forEachItem(async (item, i) => {
      const options = ctx.getNodeParameter<JsonObject>('options', i, {});
      if (operation === 'generateHtmlTemplate') {
        const template = String(ctx.getRawParameter('html') ?? '');
        const html = ctx.evaluateExpression(`=${template.startsWith('=') ? template.slice(1) : template}`, i);
        return { json: { [String(options.outputFieldName || 'html')]: typeof html === 'string' ? html : JSON.stringify(html) } };
      }

      const property = String(ctx.getNodeParameter('dataPropertyName', i, 'data') || 'data');
      let source: unknown;
      if (ctx.getNodeParameter<string>('sourceData', i, 'json') === 'binary') source = (await ctx.helpers.getBinaryDataBuffer(i, property)).toString('utf8');
      else source = readField(item.json, property);
      if (typeof source !== 'string') {
        throw new NodeOperationError(source === undefined ? `Item ${i} has no field "${property}"` : `Field "${property}" of item ${i} is not text`, {
          itemIndex: i,
          hint: `"Field With The HTML" must name a field that contains HTML text. Fields of this item: ${Object.keys(item.json).join(', ') || 'none'}.`,
        });
      }
      const extractions = ctx.getNodeParameter<Extraction[]>('extractionValues.values', i, []).filter((e) => e.key?.trim() || e.cssSelector?.trim());
      if (extractions.length === 0) throw new NodeOperationError('Add at least one extraction value', { itemIndex: i, hint: 'Give it a key (e.g. title) and a CSS selector (e.g. h1).' });
      const $ = cheerio.load(source);
      const json: JsonObject = {};
      for (const e of extractions) {
        const key = e.key?.trim();
        const selector = e.cssSelector?.trim();
        if (!key) throw new NodeOperationError(`The extraction value with selector "${selector}" has no key`, { itemIndex: i });
        if (!selector) throw new NodeOperationError(`The extraction value "${key}" has no CSS selector`, { itemIndex: i });
        if (e.returnValue === 'attribute' && !e.attribute?.trim()) throw new NodeOperationError(`"${key}": enter the attribute to read (e.g. href)`, { itemIndex: i });
        let matches;
        try {
          matches = $(selector);
        } catch (err) {
          throw new NodeOperationError(`"${selector}" is not a valid CSS selector`, { itemIndex: i, description: err instanceof Error ? err.message : undefined, hint: 'Examples: h1 · .price · #main p · a[href] · table tr td:first-child' });
        }
        const valueOf = (el: Parameters<typeof $>[0]): string | null => {
          const node = $(el as never);
          let raw: unknown;
          if (e.returnValue === 'html') raw = node.html();
          else if (e.returnValue === 'attribute') raw = node.attr(e.attribute!.trim());
          else if (e.returnValue === 'value') raw = node.val();
          else raw = node.text();
          if (raw === undefined || raw === null) return null;
          let text = Array.isArray(raw) ? raw.join(', ') : String(raw);
          if (options.cleanUpText !== false && e.returnValue !== 'html') text = clean(text);
          return options.trimValues === false ? text : text.trim();
        };
        json[key] = e.returnArray ? matches.toArray().map((el) => valueOf(el as never)) : matches.length ? valueOf(matches.first() as never) : null;
      }
      return { json };
    });
    return [out];
  },
});
