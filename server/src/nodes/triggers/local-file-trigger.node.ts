import { statSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import chokidar from 'chokidar';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode, type TriggerContext } from '../../engine/types.js';

/** Resolves the folder inside the allowed root (./data/files), refusing anything outside it. */
function watchedFolder(ctx: TriggerContext): string {
  const folder = String(ctx.getNodeParameter('path', '') ?? '').trim();
  const root = resolve(ctx.filesRoot);
  const target = resolve(root, folder);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new NodeOperationError(`The folder must be inside ${root}`, { hint: 'Use a path relative to the data/files folder, e.g. "inbox".' });
  }
  let stats;
  try {
    stats = statSync(target);
  } catch {
    throw new NodeOperationError(`The folder "${folder || '.'}" does not exist in ${root}`, { hint: 'Create it first.' });
  }
  if (!stats.isDirectory()) throw new NodeOperationError(`"${folder}" is a file, not a folder`);
  return target;
}

/** "*.tmp, .*, **\/drafts/**" → matcher on paths relative to the watched folder. */
export function ignoreMatcher(patterns: string): (relativePath: string) => boolean {
  const regexes = patterns
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const source = p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0000/g, '.*');
      return new RegExp(`(^|/)${source}$`);
    });
  return (path) => regexes.some((r) => r.test(path.split(sep).join('/')));
}

export default defineNode({
  description: {
    type: 'flowforge.localFileTrigger',
    displayName: 'Local File Trigger',
    description: 'Starts the workflow when files are added, changed or deleted in a folder of data/files.',
    icon: 'lucide:folder-search',
    group: 'trigger',
    version: 1,
    defaults: { name: 'Local File Trigger', color: '#404040' },
    subtitle: '{{path}}',
    inputs: [],
    outputs: [{ type: 'main' }],
    trigger: { kind: 'listener' },
    keywords: ['watch', 'folder', 'file', 'directory', 'filesystem'],
  },
  properties: [
    { name: 'path', displayName: 'Folder', type: 'string', default: '', placeholder: 'e.g. inbox (inside data/files)', description: 'Empty = the data/files folder itself.' },
    {
      name: 'events',
      displayName: 'Watch For',
      type: 'multiOptions',
      default: ['add'],
      options: [
        { name: 'File Added', value: 'add' },
        { name: 'File Changed', value: 'change' },
        { name: 'File Deleted', value: 'unlink' },
      ],
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'includeSubfolders', displayName: 'Include Subfolders', type: 'boolean', default: true },
        { name: 'ignored', displayName: 'Ignore', type: 'string', default: '', placeholder: '*.tmp, .*, **/drafts/**' },
      ],
    },
  ],
  validate(ctx) {
    watchedFolder(ctx);
    const events = ctx.getNodeParameter<string[]>('events', []);
    if (!events.length) throw new NodeOperationError('Choose at least one event to watch for');
  },
  async trigger(ctx) {
    const folder = watchedFolder(ctx);
    const events = new Set(ctx.getNodeParameter<string[]>('events', ['add']));
    const isIgnored = ignoreMatcher(String(ctx.getNodeParameter('options.ignored', '') ?? ''));
    const subfolders = ctx.getNodeParameter<boolean>('options.includeSubfolders', true);
    const watcher = chokidar.watch(folder, {
      ignoreInitial: true,
      depth: subfolders ? 20 : 0,
      ignored: (path: string) => path !== folder && isIgnored(relative(folder, path)),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    const emit = (event: string) => (path: string) => {
      if (!events.has(event)) return;
      const rel = relative(ctx.filesRoot, path).split(sep).join('/');
      ctx.emit([
        {
          json: {
            event,
            path: rel,
            fileName: basename(path),
            folder: dirname(rel) === '.' ? '' : dirname(rel),
            timestamp: new Date().toISOString(),
          },
        },
      ]);
    };
    watcher.on('add', emit('add')).on('change', emit('change')).on('unlink', emit('unlink'));
    watcher.on('error', (err) => ctx.emitError(err instanceof Error ? err : new Error(String(err))));
    await new Promise<void>((done) => watcher.once('ready', () => done()));
    return { close: () => watcher.close() };
  },
});
