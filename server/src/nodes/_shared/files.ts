import { existsSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { NodeOperationError } from '../../engine/errors.js';

// File nodes may only touch the files folder (./data/files, FLOWFORGE_FILES_DIR).

const outside = (root: string, path: string) =>
  new NodeOperationError(`"${path}" is outside the files folder`, {
    hint: `File nodes can only use ${root}. Give a path relative to it, e.g. "reports/data.csv" (change the folder with FLOWFORGE_FILES_DIR).`,
  });

const inside = (root: string, target: string) => target === root || target.startsWith(root + sep);

/** Absolute path of `path` inside `root`; refuses "..", absolute paths elsewhere and symlinks that leave the folder. */
export function resolveInRoot(root: string, path: string): string {
  const cleanRoot = resolve(root);
  const given = String(path ?? '').trim();
  if (!given) throw new NodeOperationError('The file path is empty', { hint: 'Enter a path inside the files folder, e.g. "reports/data.csv".' });
  if (given.includes('\0')) throw outside(cleanRoot, given);
  const target = isAbsolute(given) ? resolve(given) : resolve(cleanRoot, given);
  if (!inside(cleanRoot, target)) throw outside(cleanRoot, given);
  // A link inside the folder must not lead out of it: check the deepest part that exists.
  let existing = target;
  while (!existsSync(existing) && existing !== dirname(existing)) existing = dirname(existing);
  const realRoot = existsSync(cleanRoot) ? realpathSync(cleanRoot) : cleanRoot;
  if (existsSync(existing) && !inside(realRoot, realpathSync(existing))) throw outside(cleanRoot, given);
  return target;
}

export const hasGlob = (pattern: string) => /[*?{]/.test(pattern);

/** "reports/**\/*.csv" → RegExp on "/"-separated relative paths. */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) out += '\\{';
      else {
        out += `(?:${pattern
          .slice(i + 1, end)
          .split(',')
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&'))
          .join('|')})`;
        i = end;
      }
    } else out += /[.+^$()|[\]\\}]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${out}$`);
}

/** Files of the folder matching a glob pattern (relative paths with "/", sorted). */
export async function findFiles(root: string, pattern: string, limit = 1000): Promise<string[]> {
  const cleanRoot = resolve(root);
  const normalized = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) throw outside(cleanRoot, pattern);
  const regex = globToRegExp(normalized);
  // Start in the fixed part of the pattern ("reports/2026/*.csv" → reports/2026).
  const parts = normalized.split('/');
  const fixed: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (hasGlob(part)) break;
    fixed.push(part);
  }
  const start = resolveInRoot(cleanRoot, fixed.join('/') || '.');
  if (!existsSync(start)) return [];
  const deep = normalized.includes('**');
  const maxDepth = deep ? 32 : parts.length - fixed.length;
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= limit || depth > maxDepth) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (found.length >= limit) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile()) {
        const rel = relative(cleanRoot, full).split(sep).join('/');
        if (regex.test(rel)) found.push(rel);
      }
    }
  };
  await walk(start, 1);
  return found.sort();
}
