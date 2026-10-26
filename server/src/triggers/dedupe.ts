import { createHash } from 'node:crypto';
import type { Item } from '@flowforge/shared';
import { getPath } from '../engine/params.js';

export const DEDUPE_MAX_KEYS = 5000;

/** JSON with sorted keys, so the same object always hashes the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const hashItem = (item: Item) => createHash('sha256').update(stable(item.json)).digest('hex');

export interface DedupeOptions {
  /** Field that identifies an item (e.g. "id" or "guid"); empty = SHA-256 of the whole item. */
  key?: string;
  /** First poll after activation: emit what is already there (default: only remember it). */
  emitExistingOnFirstRun?: boolean;
  max?: number;
}

/**
 * Returns only the items not seen before and remembers them in `state` (kept in the workflow's
 * static data, so it survives restarts). The remembered keys are an LRU list of 5000 entries.
 */
export function dedupe(state: Record<string, unknown>, items: Item[], options: DedupeOptions = {}): Item[] {
  const seen: string[] = Array.isArray(state.seen) ? (state.seen as string[]) : [];
  const known = new Set(seen);
  const firstRun = state.initialized !== true;
  const fresh: Item[] = [];
  for (const item of items) {
    const raw = options.key ? getPath(item.json, options.key) : undefined;
    const key = raw === undefined || raw === null || raw === '' ? hashItem(item) : `k:${String(raw)}`;
    if (known.has(key)) continue;
    known.add(key);
    seen.push(key);
    fresh.push(item);
  }
  const max = options.max ?? DEDUPE_MAX_KEYS;
  if (seen.length > max) seen.splice(0, seen.length - max);
  state.seen = seen;
  state.initialized = true;
  return firstRun && !options.emitExistingOnFirstRun ? [] : fresh;
}

/** Poll interval from the standard "pollInterval" + "pollUnit" parameters (minimum 1 second). */
export function pollIntervalMs(amount: unknown, unit: unknown): number {
  const n = Math.max(1, Number(amount) || 1);
  const factor = unit === 'hours' ? 3_600_000 : unit === 'minutes' ? 60_000 : 1000;
  return n * factor;
}
