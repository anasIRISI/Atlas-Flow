import type { ApiErrorBody } from '@flowforge/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly hint?: string,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Calls `/api/<path>`; throws ApiError with the server's human-readable message on failure. */
export async function api<T>(path: string, options: { method?: Method; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the FlowForge server. Is it running?', 'network');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | undefined)?.error;
    throw new ApiError(res.status, err?.message ?? `Request failed (HTTP ${res.status})`, err?.code, err?.hint);
  }
  return data as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.hint ? `${err.message} ${err.hint}` : err.message;
  return err instanceof Error ? err.message : String(err);
}
