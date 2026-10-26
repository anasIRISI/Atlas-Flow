import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { BinaryRef } from '@flowforge/shared';
import { NodeOperationError } from './errors.js';

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html',
  '.xml': 'application/xml', '.md': 'text/markdown', '.pdf': 'application/pdf', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.ics': 'text/calendar',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const ID_PATTERN = /^[\w-]{1,64}\/[\w-]{1,64}$/;

export function guessMimeType(fileName?: string): string {
  return (fileName && MIME_BY_EXT[extname(fileName).toLowerCase()]) || 'application/octet-stream';
}

/** Stores binary content on disk under <dataDir>/binary/<executionId>/<uuid>; items only keep a BinaryRef. */
export class BinaryStore {
  constructor(private readonly baseDir: string) {}

  private pathFor(id: string): string {
    if (!ID_PATTERN.test(id)) throw new NodeOperationError(`Invalid binary data id "${id}"`);
    return join(this.baseDir, ...id.split('/'));
  }

  async store(executionId: string, data: Buffer, fileName?: string, mimeType?: string): Promise<BinaryRef> {
    const id = `${executionId.replace(/[^\w-]/g, '_')}/${randomUUID()}`;
    const path = this.pathFor(id);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, data);
    const ref: BinaryRef = { id, mimeType: mimeType || guessMimeType(fileName), fileSize: data.length };
    await writeFile(`${path}.meta.json`, JSON.stringify({ mimeType: ref.mimeType, fileName }));
    if (fileName) {
      ref.fileName = fileName;
      const ext = extname(fileName).slice(1);
      if (ext) ref.fileExtension = ext.toLowerCase();
    }
    return ref;
  }

  async read(ref: Pick<BinaryRef, 'id'>): Promise<Buffer> {
    const path = this.pathFor(ref.id);
    if (!existsSync(path)) {
      throw new NodeOperationError('The binary file no longer exists', {
        hint: 'It may belong to an execution that was deleted. Run the workflow again.',
      });
    }
    return readFile(path);
  }

  /** Mime type and file name saved next to the file (used by the download endpoint). */
  async readMeta(id: string): Promise<{ mimeType: string; fileName?: string }> {
    try {
      return JSON.parse(await readFile(`${this.pathFor(id)}.meta.json`, 'utf8')) as { mimeType: string; fileName?: string };
    } catch {
      return { mimeType: 'application/octet-stream' };
    }
  }

  exists(id: string): boolean {
    try {
      return existsSync(this.pathFor(id));
    } catch {
      return false;
    }
  }

  async deleteExecution(executionId: string): Promise<void> {
    if (!/^[\w-]{1,64}$/.test(executionId)) return;
    await rm(join(this.baseDir, executionId), { recursive: true, force: true });
  }
}
