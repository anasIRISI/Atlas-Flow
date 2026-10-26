import type { JsonObject, NodeProperty } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import type { ExecuteContext, ToolParameters } from '../../engine/types.js';

// Shared by the AI tool sub-nodes: tool name / description, and the "parameters the model fills in" collection.

export const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Name and description properties every tool has (shown first in the panel). */
export function toolIdentityProperties(defaultName: string, defaultDescription: string): NodeProperty[] {
  return [
    {
      name: 'toolName',
      displayName: 'Tool Name',
      type: 'string',
      default: defaultName,
      description: 'The name the AI model sees: letters, digits and underscores, at most 64 characters, not starting with a digit.',
      noDataExpression: true,
    },
    {
      name: 'toolDescription',
      displayName: 'Description',
      type: 'string',
      default: defaultDescription,
      typeOptions: { rows: 3 },
      description: 'Tells the model what the tool does and when to use it. The better this text, the better the model uses the tool.',
    },
  ];
}

/** Reads and validates the tool name and description. */
export function toolIdentity(ctx: ExecuteContext, itemIndex: number, defaultName: string, defaultDescription: string): { name: string; description: string } {
  const name = String(ctx.getNodeParameter<unknown>('toolName', itemIndex, defaultName) ?? '').trim() || defaultName;
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new NodeOperationError(`"${name}" is not a valid tool name`, {
      itemIndex,
      hint: 'Use letters, digits and underscores only (at most 64 characters, not starting with a digit), for example get_weather.',
    });
  }
  const description = String(ctx.getNodeParameter<unknown>('toolDescription', itemIndex, defaultDescription) ?? '').trim() || defaultDescription;
  return { name, description };
}

export type ToolParameterType = 'string' | 'number' | 'boolean';

export interface DeclaredParameter {
  name: string;
  description: string;
  type: ToolParameterType;
  required: boolean;
}

/** The "Parameters the model fills in" list (name, description, type, required). */
export const TOOL_PARAMETERS_PROPERTY: NodeProperty = {
  name: 'toolParameters',
  displayName: 'Tool Parameters',
  type: 'fixedCollection',
  default: {},
  placeholder: 'Add parameter',
  description: 'The values the model chooses when it calls the tool.',
  typeOptions: { multipleValues: true },
  noDataExpression: true,
  options: [
    {
      name: 'parameter',
      displayName: 'Parameter',
      values: [
        { name: 'name', displayName: 'Name', type: 'string', default: '', placeholder: 'e.g. city', description: 'Letters, digits and underscores.' },
        { name: 'description', displayName: 'Description', type: 'string', default: '', placeholder: 'What the model must put here' },
        {
          name: 'type',
          displayName: 'Type',
          type: 'options',
          default: 'string',
          options: [
            { name: 'String', value: 'string' },
            { name: 'Number', value: 'number' },
            { name: 'Boolean', value: 'boolean' },
          ],
        },
        { name: 'required', displayName: 'Required', type: 'boolean', default: true },
      ],
    },
  ],
};

/** Declared parameters of a node; refuses empty / invalid / duplicate names. */
export function readDeclaredParameters(ctx: ExecuteContext, itemIndex: number): DeclaredParameter[] {
  const raw = ctx.getNodeParameter<unknown>('toolParameters', itemIndex, {}) as { parameter?: unknown } | null;
  const rows = Array.isArray(raw?.parameter) ? (raw.parameter as JsonObject[]) : [];
  const seen = new Set<string>();
  const out: DeclaredParameter[] = [];
  for (const row of rows) {
    const name = String(row?.name ?? '').trim();
    if (!name) continue; // an empty row in the editor
    if (!TOOL_NAME_PATTERN.test(name)) {
      throw new NodeOperationError(`"${name}" is not a valid parameter name`, { itemIndex, hint: 'Use letters, digits and underscores only, not starting with a digit.' });
    }
    if (seen.has(name)) throw new NodeOperationError(`The parameter "${name}" is declared twice`, { itemIndex });
    seen.add(name);
    const type = row.type === 'number' || row.type === 'boolean' ? row.type : 'string';
    out.push({ name, description: String(row.description ?? '').trim(), type, required: row.required !== false });
  }
  return out;
}

/** JSON Schema given to the model. */
export function toSchema(parameters: DeclaredParameter[]): ToolParameters {
  const properties: Record<string, JsonObject> = {};
  for (const p of parameters) properties[p.name] = p.description ? { type: p.type, description: p.description } : { type: p.type };
  const required = parameters.filter((p) => p.required).map((p) => p.name);
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

/** Converts an argument chosen by the model to the declared type; throws a message the model can act on. */
export function coerceArgument(p: DeclaredParameter, value: unknown): string | number | boolean {
  if (p.type === 'number') {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`The argument "${p.name}" must be a number`);
    return n;
  }
  if (p.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true' || value === 'false') return value === 'true';
    throw new Error(`The argument "${p.name}" must be true or false`);
  }
  if (typeof value === 'object' && value !== null) throw new Error(`The argument "${p.name}" must be a string`);
  return String(value);
}
