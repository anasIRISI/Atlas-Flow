import { NodeOperationError } from '../../engine/errors.js';

/** fetch() with a timeout and readable errors (used by polling triggers). */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NodeOperationError(`"${url}" is not a valid URL`, { hint: 'It must start with http:// or https://' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new NodeOperationError('Only http:// and https:// URLs are supported');
  let res: Response;
  try {
    res = await fetch(parsed, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'FlowForge/0.1', ...(init.headers ?? {}) } });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    if (e.name === 'TimeoutError') throw new NodeOperationError(`No answer from ${parsed.host} after ${timeoutMs / 1000} s`);
    throw new NodeOperationError(`Could not reach ${parsed.host}${e.cause?.code ? ` (${e.cause.code})` : ''}`, { hint: 'Check the URL and your internet connection.' });
  }
  if (!res.ok) throw new NodeOperationError(`${parsed.host} answered HTTP ${res.status} ${res.statusText}`.trim());
  return res;
}

export function assertHttpUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    throw new NodeOperationError(url ? `"${url}" is not a valid URL` : 'The URL is empty', { hint: 'It must start with http:// or https://' });
  }
}
