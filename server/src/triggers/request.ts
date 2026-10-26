import type { IncomingMessage } from 'node:http';
import busboy from 'busboy';

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface UploadedFile {
  field: string;
  fileName: string;
  mimeType: string;
  data: Buffer;
}

export interface ParsedRequest {
  contentType: string;
  body: unknown;
  rawBody: Buffer;
  files: UploadedFile[];
}

function readRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBytes) {
      reject(new RequestError(413, `The request body is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new RequestError(413, `The request body is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function addField(target: Record<string, unknown>, key: string, value: unknown) {
  const name = key.endsWith('[]') ? key.slice(0, -2) : key;
  if (name in target) {
    const current = target[name];
    target[name] = Array.isArray(current) ? [...current, value] : [current, value];
  } else target[name] = key.endsWith('[]') ? [value] : value;
}

function readMultipart(req: IncomingMessage, maxBytes: number): Promise<{ body: Record<string, unknown>; files: UploadedFile[] }> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 20, fields: 500 } });
    } catch {
      reject(new RequestError(400, 'Invalid multipart request'));
      return;
    }
    const body: Record<string, unknown> = {};
    const files: UploadedFile[] = [];
    let total = 0;
    let failed = false;
    const fail = (err: RequestError) => {
      if (failed) return;
      failed = true;
      reject(err);
      req.unpipe(bb);
      req.resume();
    };
    bb.on('field', (name, value) => addField(body, name, value));
    bb.on('file', (field, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) fail(new RequestError(413, `The upload is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
        else chunks.push(c);
      });
      stream.on('limit', () => fail(new RequestError(413, 'A file is too large')));
      stream.on('end', () => {
        if (info.filename) files.push({ field, fileName: info.filename, mimeType: info.mimeType || 'application/octet-stream', data: Buffer.concat(chunks) });
      });
    });
    bb.on('close', () => !failed && resolve({ body, files }));
    bb.on('error', () => fail(new RequestError(400, 'Invalid multipart request')));
    req.pipe(bb);
  });
}

/** Reads and parses any request body: JSON, urlencoded, text, multipart (files) or raw bytes. */
export async function parseRequest(req: IncomingMessage, maxBytes: number): Promise<ParsedRequest> {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (contentType.startsWith('multipart/form-data')) {
    const { body, files } = await readMultipart(req, maxBytes);
    return { contentType, body, rawBody: Buffer.alloc(0), files };
  }
  const rawBody = await readRaw(req, maxBytes);
  if (rawBody.length === 0) return { contentType, body: {}, rawBody, files: [] };
  if (contentType.includes('json')) {
    try {
      return { contentType, body: JSON.parse(rawBody.toString('utf8')), rawBody, files: [] };
    } catch {
      throw new RequestError(400, 'The request body is not valid JSON');
    }
  }
  if (contentType.startsWith('application/x-www-form-urlencoded')) {
    const body: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(rawBody.toString('utf8'))) addField(body, k, v);
    return { contentType, body, rawBody, files: [] };
  }
  if (contentType.startsWith('text/') || contentType.includes('xml') || contentType === '') {
    return { contentType, body: rawBody.toString('utf8'), rawBody, files: [] };
  }
  // Other types (images, PDFs, octet-stream…) are kept as bytes and become binary data.
  return { contentType, body: {}, rawBody, files: [] };
}
