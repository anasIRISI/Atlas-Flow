import type { Item, JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { getPath } from '../../engine/params.js';
import { defineNode } from '../../engine/types.js';

type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

interface Assignment {
  id?: string;
  name: string;
  value: unknown;
  type?: FieldType;
}

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);

function setPath(target: JsonObject, path: string, value: unknown, dotNotation: boolean): void {
  if (!dotNotation || !path.includes('.')) {
    target[path] = value;
    return;
  }
  const keys = path.split('.');
  let current = target;
  for (const key of keys.slice(0, -1)) {
    if (!isObject(current[key])) current[key] = {};
    current = current[key] as JsonObject;
  }
  current[keys[keys.length - 1]!] = value;
}

function deletePath(target: JsonObject, path: string): void {
  const keys = path.split('.');
  let current: unknown = target;
  for (const key of keys.slice(0, -1)) {
    if (!isObject(current)) return;
    current = current[key];
  }
  if (isObject(current)) delete current[keys[keys.length - 1]!];
}

/** Converts a value to the requested field type; throws a readable error when impossible. */
function convert(name: string, value: unknown, type: FieldType): unknown {
  const fail = (): never => {
    throw new NodeOperationError(`Value of "${name}" (${JSON.stringify(value)}) cannot be converted to ${type}`, {
      hint: 'Change the field type, fix the value, or enable "Ignore Type Conversion Errors".',
    });
  };
  switch (type) {
    case 'string':
      return value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    case 'number': {
      if (typeof value === 'number') return value;
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'boolean' ? Number(value) : NaN;
      return Number.isNaN(n) ? fail() : n;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).trim().toLowerCase();
      if (['true', '1', 'yes'].includes(s)) return true;
      if (['false', '0', 'no', ''].includes(s)) return false;
      return fail();
    }
    case 'array': {
      if (Array.isArray(value)) return value;
      if (typeof value === 'string') {
        try {
          const parsed: unknown = JSON.parse(value);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          /* handled below */
        }
      }
      return fail();
    }
    case 'object': {
      if (isObject(value)) return value;
      if (typeof value === 'string') {
        try {
          const parsed: unknown = JSON.parse(value);
          if (isObject(parsed)) return parsed;
        } catch {
          /* handled below */
        }
      }
      return fail();
    }
  }
}

export default defineNode({
  description: {
    type: 'flowforge.set',
    displayName: 'Edit Fields (Set)',
    description: 'Adds, changes or removes fields on each item.',
    icon: 'lucide:pen-line',
    group: 'transform',
    version: 1,
    defaults: { name: 'Edit Fields', color: '#5b8cff' },
    subtitle: '{{mode}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['set', 'edit', 'fields', 'map', 'rename', 'transform'],
  },
  properties: [
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'options',
      default: 'manual',
      options: [
        { name: 'Manual Mapping', value: 'manual', description: 'Edit item fields one by one' },
        { name: 'JSON', value: 'raw', description: 'Write the output as JSON' },
      ],
    },
    {
      name: 'assignments',
      displayName: 'Fields to Set',
      type: 'assignments',
      default: { assignments: [] },
      displayOptions: { show: { mode: ['manual'] } },
    },
    {
      name: 'jsonOutput',
      displayName: 'JSON',
      type: 'json',
      default: '{\n  "my_field_1": "value",\n  "my_field_2": 1\n}',
      displayOptions: { show: { mode: ['raw'] } },
    },
    {
      name: 'includeOtherFields',
      displayName: 'Include Other Input Fields',
      type: 'boolean',
      default: false,
      description: 'Keep the fields of the input item in addition to the fields set here.',
    },
    {
      name: 'include',
      displayName: 'Input Fields to Include',
      type: 'options',
      default: 'all',
      displayOptions: { show: { includeOtherFields: [true] } },
      options: [
        { name: 'All', value: 'all' },
        { name: 'Selected', value: 'selected' },
        { name: 'All Except', value: 'except' },
      ],
    },
    {
      name: 'includeFields',
      displayName: 'Fields to Include',
      type: 'string',
      default: '',
      placeholder: 'e.g. id, name',
      displayOptions: { show: { includeOtherFields: [true], include: ['selected'] } },
    },
    {
      name: 'excludeFields',
      displayName: 'Fields to Exclude',
      type: 'string',
      default: '',
      placeholder: 'e.g. password',
      displayOptions: { show: { includeOtherFields: [true], include: ['except'] } },
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'dotNotation', displayName: 'Support Dot Notation', type: 'boolean', default: true, description: '"a.b" sets field b inside object a' },
        { name: 'ignoreConversionErrors', displayName: 'Ignore Type Conversion Errors', type: 'boolean', default: false },
        { name: 'includeBinary', displayName: 'Include Binary Data', type: 'boolean', default: true },
      ],
    },
  ],
  async execute(ctx) {
    const items = await ctx.forEachItem((item, i): Item => {
      const dot = ctx.getNodeParameter<boolean>('options.dotNotation', i, true);
      const ignoreErrors = ctx.getNodeParameter<boolean>('options.ignoreConversionErrors', i, false);
      let json: JsonObject = {};
      if (ctx.getNodeParameter<boolean>('includeOtherFields', i, false)) {
        const include = ctx.getNodeParameter<string>('include', i, 'all');
        const list = (name: string) =>
          ctx
            .getNodeParameter<string>(name, i, '')
            .split(',')
            .map((f) => f.trim())
            .filter(Boolean);
        if (include === 'selected') {
          for (const field of list('includeFields')) {
            const value = dot ? getPath(item.json, field) : item.json[field];
            if (value !== undefined) setPath(json, field, structuredClone(value), dot);
          }
        } else {
          json = structuredClone(item.json);
          if (include === 'except') for (const field of list('excludeFields')) dot ? deletePath(json, field) : delete json[field];
        }
      }

      if (ctx.getNodeParameter('mode', i) === 'raw') {
        let value = ctx.getNodeParameter<unknown>('jsonOutput', i);
        if (typeof value === 'string') {
          try {
            value = JSON.parse(value);
          } catch (err) {
            throw new NodeOperationError('The JSON output is not valid JSON', {
              description: (err as Error).message,
              hint: 'Check commas and quotes. Text values must be in double quotes.',
              itemIndex: i,
            });
          }
        }
        if (!isObject(value)) throw new NodeOperationError('The JSON output must be an object, e.g. { "name": "value" }', { itemIndex: i });
        json = { ...json, ...structuredClone(value) };
      } else {
        const assignments = ctx.getNodeParameter<{ assignments?: Assignment[] }>('assignments', i, {}).assignments ?? [];
        for (const a of assignments) {
          if (!a?.name) continue;
          let value = a.value;
          try {
            value = convert(a.name, a.value, a.type ?? 'string');
          } catch (err) {
            if (!ignoreErrors) throw err;
          }
          setPath(json, a.name, value, dot);
        }
      }

      const includeBinary = ctx.getNodeParameter<boolean>('options.includeBinary', i, true);
      return { json, ...(includeBinary && item.binary ? { binary: item.binary } : {}), pairedItem: { item: i } };
    });
    return [items];
  },
});
