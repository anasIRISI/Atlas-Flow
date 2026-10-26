import type { FixedCollectionGroup, JsonObject, NodeProperty } from '@flowforge/shared';

/** Reads `a.b.c` from an object. */
export function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isGroupList(options: NodeProperty['options']): options is FixedCollectionGroup[] {
  return Array.isArray(options) && options.length > 0 && 'values' in (options[0] as object);
}

function isPropertyList(options: NodeProperty['options']): options is NodeProperty[] {
  return Array.isArray(options) && options.length > 0 && 'type' in (options[0] as object) && 'default' in (options[0] as object);
}

/** Default value declared in the schema for a (possibly nested) parameter path, e.g. `options.ignoreCase`. */
export function getDefault(properties: NodeProperty[], path: string): unknown {
  const [head, ...rest] = path.split('.');
  const prop = properties.find((p) => p.name === head);
  if (!prop) return undefined;
  if (rest.length === 0) return structuredClone(prop.default);
  if (prop.type === 'collection' && isPropertyList(prop.options)) return getDefault(prop.options, rest.join('.'));
  if (prop.type === 'fixedCollection' && isGroupList(prop.options)) {
    const [groupName, ...inner] = rest;
    const group = prop.options.find((g) => g.name === groupName);
    if (group && inner.length) return getDefault(group.values, inner.join('.'));
  }
  return getPath(prop.default, rest.join('.'));
}

/** True if the property at `path` must never be evaluated as an expression (e.g. Code). */
export function isNoExpression(properties: NodeProperty[], path: string): boolean {
  const head = path.split('.')[0];
  return properties.find((p) => p.name === head)?.noDataExpression === true;
}

/** Parameters with schema defaults filled in for missing top-level keys (used for dynamic outputs). */
export function withDefaults(properties: NodeProperty[], parameters: JsonObject): JsonObject {
  const out: JsonObject = { ...parameters };
  for (const prop of properties) {
    if (out[prop.name] === undefined && prop.type !== 'notice') out[prop.name] = structuredClone(prop.default);
  }
  return out;
}
