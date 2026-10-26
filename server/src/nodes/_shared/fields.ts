import type { JsonObject } from '@flowforge/shared';

// Field access shared by the data nodes (Aggregate, Split Out, Summarize, …).

export const isPlainObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** "name, address.city ,, email" → ["name", "address.city", "email"]. Arrays are accepted too. */
export function fieldList(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.map(String) : String(value ?? '').split(',');
  return [...new Set(parts.map((p) => p.trim()).filter(Boolean))];
}

/** Reads a field; with dot notation "a.b" is the field b inside a. */
export function readField(source: unknown, field: string, dotNotation = true): unknown {
  if (!dotNotation || !field.includes('.')) return isPlainObject(source) ? source[field] : undefined;
  let current: unknown = source;
  for (const key of field.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function hasField(source: unknown, field: string, dotNotation = true): boolean {
  return readField(source, field, dotNotation) !== undefined;
}

/** Writes a field, creating the objects on the way for dotted names. */
export function writeField(target: JsonObject, field: string, value: unknown, dotNotation = true): void {
  if (!dotNotation || !field.includes('.')) {
    target[field] = value as JsonObject[string];
    return;
  }
  const keys = field.split('.');
  let current = target;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key] as JsonObject;
  }
  current[keys[keys.length - 1]!] = value as JsonObject[string];
}

export function removeField(target: JsonObject, field: string, dotNotation = true): void {
  if (!dotNotation || !field.includes('.')) {
    delete target[field];
    return;
  }
  const keys = field.split('.');
  let current: unknown = target;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(current)) return;
    current = current[key];
  }
  if (isPlainObject(current)) delete current[keys[keys.length - 1]!];
}

/** Last part of a dotted field name ("address.city" → "city"). */
export const leafName = (field: string, dotNotation = true) => (dotNotation ? field.split('.').pop()! : field);

/** Stable text form of a value, used to compare or group items (object keys are sorted). */
export function stableKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  return `{${Object.keys(value as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableKey((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/** A deep copy of plain JSON data. */
export const cloneJson = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));
