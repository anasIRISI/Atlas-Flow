import type { FixedCollectionGroup, NodeProperty, PropertyOption } from '@flowforge/shared';

export type Values = Record<string, unknown>;

export const isPropertyList = (o: NodeProperty['options']): o is NodeProperty[] =>
  Array.isArray(o) && o.length > 0 && typeof o[0] === 'object' && 'type' in (o[0] as object) && 'default' in (o[0] as object);

export const isGroupList = (o: NodeProperty['options']): o is FixedCollectionGroup[] =>
  Array.isArray(o) && o.length > 0 && typeof o[0] === 'object' && 'values' in (o[0] as object);

export const isOptionList = (o: NodeProperty['options']): o is PropertyOption[] =>
  Array.isArray(o) && (o.length === 0 || (typeof o[0] === 'object' && 'value' in (o[0] as object)));

/** Values of one level with schema defaults filled in. */
export function withDefaults(properties: NodeProperty[], values: Values): Values {
  const out: Values = { ...values };
  for (const p of properties) if (out[p.name] === undefined) out[p.name] = p.default;
  return out;
}

/**
 * n8n-style displayOptions: `show` = every listed field must have one of the values,
 * `hide` = hidden if any listed field matches. "/name" refers to a top-level parameter.
 */
/** A multi-select value (array) matches when at least one of its entries is listed. */
const listed = (list: unknown[], value: unknown) => (Array.isArray(value) ? value.some((v) => list.includes(v)) : list.includes(value));

export function isVisible(prop: NodeProperty, level: Values, root: Values): boolean {
  const lookup = (key: string) => (key.startsWith('/') ? root[key.slice(1)] : key in level ? level[key] : root[key]);
  const { show, hide } = prop.displayOptions ?? {};
  if (show && !Object.entries(show).every(([key, allowed]) => listed(allowed, lookup(key)))) return false;
  if (hide && Object.entries(hide).some(([key, blocked]) => listed(blocked, lookup(key)))) return false;
  return true;
}

export function setIn(values: Values, path: Array<string | number>, value: unknown): Values {
  if (path.length === 0) return value as Values;
  const [head, ...rest] = path;
  const container: Values | unknown[] = Array.isArray(values) ? [...values] : { ...(values ?? {}) };
  const current = (container as Record<string | number, unknown>)[head!];
  const next = rest.length ? setIn((current ?? (typeof rest[0] === 'number' ? [] : {})) as Values, rest, value) : value;
  if (next === undefined && !Array.isArray(container)) delete (container as Values)[head as string];
  else (container as Record<string | number, unknown>)[head!] = next;
  return container as Values;
}
