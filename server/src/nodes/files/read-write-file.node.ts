import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import type { Item, JsonObject, NodeProperty } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { findFiles, hasGlob, resolveInRoot } from '../_shared/files.js';

const show = (...operation: string[]): NodeProperty['displayOptions'] => ({ show: { operation } });
const MAX_FILE_BYTES = 100 * 1024 * 1024;

export default defineNode({
  description: {
    type: 'flowforge.readWriteFile',
    displayName: 'Read/Write Files from Disk',
    description: 'Reads or writes files in the FlowForge files folder (data/files) of this computer.',
    icon: 'lucide:hard-drive',
    group: 'files',
    version: 1,
    defaults: { name: 'Read/Write Files from Disk', color: '#3aa981' },
    subtitle: '{{operation}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['file', 'disk', 'read', 'write', 'save', 'load', 'folder', 'binary', 'local'],
  },
  properties: [
    {
      name: 'notice',
      displayName: 'For safety, files are limited to the "data/files" folder of FlowForge. Use paths relative to it, e.g. reports/sales.csv.',
      type: 'notice',
      default: '',
    },
    {
      name: 'operation',
      displayName: 'Operation',
      type: 'options',
      default: 'read',
      options: [
        { name: 'Read File(s) From Disk', value: 'read' },
        { name: 'Write File to Disk', value: 'write' },
      ],
    },
    {
      name: 'fileSelector',
      displayName: 'File(s) Selector',
      type: 'string',
      default: '',
      required: true,
      placeholder: 'e.g. reports/sales.csv or reports/*.csv',
      description: 'A path, or a pattern: * = any name, ** = any sub-folder, {a,b} = a or b.',
      displayOptions: show('read'),
    },
    { name: 'fileName', displayName: 'File Path and Name', type: 'string', default: '', required: true, placeholder: 'e.g. reports/sales.csv', displayOptions: show('write') },
    { name: 'dataPropertyName', displayName: 'Input Binary Field', type: 'string', default: 'data', description: 'Binary property that holds the file to write.', displayOptions: show('write') },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'dataPropertyName', displayName: 'Put Output File in Field (Read)', type: 'string', default: 'data' },
        { name: 'mimeType', displayName: 'MIME Type (Read)', type: 'string', default: '', placeholder: 'e.g. text/csv' },
        { name: 'append', displayName: 'Append (Write)', type: 'boolean', default: false, description: 'Add to the end of an existing file instead of replacing it.' },
      ],
    },
  ],
  async execute(ctx) {
    const root = resolve(ctx.getFilesRoot());
    const rel = (path: string) => relative(root, path).split(sep).join('/');

    const out = await ctx.forEachItem(async (item, i): Promise<Item | Item[]> => {
      const options = ctx.getNodeParameter<JsonObject>('options', i, {});
      if (ctx.getNodeParameter<string>('operation', i, 'read') === 'write') {
        const target = resolveInRoot(root, String(ctx.getNodeParameter('fileName', i, '')));
        if (target === root) throw new NodeOperationError('Enter a file name, not only the folder', { itemIndex: i });
        const property = String(ctx.getNodeParameter('dataPropertyName', i, 'data') || 'data');
        const data = await ctx.helpers.getBinaryDataBuffer(i, property);
        try {
          await mkdir(dirname(target), { recursive: true });
          if (options.append === true) await appendFile(target, data);
          else await writeFile(target, data);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          throw new NodeOperationError(`Could not write "${rel(target)}"${code ? ` (${code})` : ''}`, {
            itemIndex: i,
            hint: code === 'EISDIR' ? 'A folder with that name already exists.' : code === 'EACCES' ? 'FlowForge has no permission to write there.' : undefined,
          });
        }
        return { json: { ...item.json, fileName: rel(target), fileSize: (await stat(target)).size }, ...(item.binary ? { binary: item.binary } : {}) };
      }

      const selector = String(ctx.getNodeParameter('fileSelector', i, '')).trim();
      if (!selector) throw new NodeOperationError('The file selector is empty', { itemIndex: i, hint: 'Enter a path inside the files folder, e.g. "reports/sales.csv".' });
      let paths: string[];
      if (hasGlob(selector)) paths = (await findFiles(root, selector)).map((p) => resolveInRoot(root, p));
      else {
        const target = resolveInRoot(root, selector);
        const info = await stat(target).catch(() => undefined);
        if (!info) throw new NodeOperationError(`File "${selector}" not found`, { itemIndex: i, hint: `It is looked for in ${root}. Use a pattern such as "*.csv" to read several files.` });
        if (info.isDirectory()) throw new NodeOperationError(`"${selector}" is a folder`, { itemIndex: i, hint: `Use a pattern such as "${selector.replace(/\/$/, '')}/*" to read its files.` });
        paths = [target];
      }
      const property = String(options.dataPropertyName || 'data');
      const result: Item[] = [];
      for (const path of paths) {
        const info = await stat(path);
        if (info.size > MAX_FILE_BYTES) throw new NodeOperationError(`"${rel(path)}" is larger than 100 MB`, { itemIndex: i });
        const ref = await ctx.helpers.prepareBinaryData(await readFile(path), basename(path), String(options.mimeType || '') || undefined);
        result.push({
          json: { fileName: basename(path), directory: rel(dirname(path)) || '.', path: rel(path), fileExtension: extname(path).slice(1).toLowerCase(), mimeType: ref.mimeType, fileSize: info.size },
          binary: { [property]: ref },
          pairedItem: { item: i },
        });
      }
      return result;
    });
    return [out];
  },
});
