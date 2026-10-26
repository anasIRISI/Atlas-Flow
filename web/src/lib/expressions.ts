/** Client helpers for n8n-style expressions ("=…{{ }}"). Evaluation always happens on the server. */

export const isExpression = (v: unknown): v is string => typeof v === 'string' && v.startsWith('=');

/** Fixed value → expression text (without changing what it means). */
export function toExpression(value: unknown): string {
  if (isExpression(value)) return value;
  if (value === undefined || value === null || value === '') return '=';
  if (typeof value === 'string') return `=${value}`;
  return `={{ ${JSON.stringify(value)} }}`;
}

/** Expression → fixed value: "={{ 5 }}" → 5, "=hello" → "hello". */
export function fromExpression(value: string, kind: 'string' | 'number' | 'boolean' | 'other'): unknown {
  const text = value.slice(1);
  const single = /^\s*\{\{\s*([\s\S]*?)\s*\}\}\s*$/.exec(text);
  if (single && kind !== 'string') {
    try {
      return JSON.parse(single[1]!);
    } catch {
      /* not a literal */
    }
  }
  if (kind === 'number') {
    const n = Number(text);
    return text.trim() && !Number.isNaN(n) ? n : 0;
  }
  if (kind === 'boolean') return text.trim() === 'true';
  return text.includes('{{') ? '' : text;
}

/** Path segments → "$json.a.b[0]" / "$json['my key']". */
export function jsonPath(base: string, segments: Array<string | number>): string {
  return segments.reduce<string>((acc, seg) => {
    if (typeof seg === 'number') return `${acc}[${seg}]`;
    return /^[A-Za-z_$][\w$]*$/.test(seg) ? `${acc}.${seg}` : `${acc}['${seg.replace(/'/g, "\\'")}']`;
  }, base);
}

/** MIME type used when dragging a field from the INPUT panel. */
export const FIELD_DRAG_TYPE = 'application/x-flowforge-field';

export interface DraggedField {
  /** e.g. "{{ $json.address.city }}" */
  expression: string;
  /** last key, e.g. "city" */
  name: string;
  valueType: string;
}

/** Inserts a dropped field into a parameter value (fixed values become expressions). */
export function withDroppedField(current: unknown, expression: string): string {
  if (isExpression(current)) return `${current}${current.length > 1 && !current.endsWith(' ') ? ' ' : ''}${expression}`;
  if (current === undefined || current === null || current === '' || typeof current !== 'string') return `=${expression}`;
  return `=${current} ${expression}`;
}

export interface HelperInfo {
  name: string;
  on: 'string' | 'array' | 'number' | 'object';
  info: string;
}

/** Data transformation functions available in expressions (shown in autocomplete). */
export const EXPRESSION_HELPERS: HelperInfo[] = [
  ...[
    ['toTitleCase', 'Capitalize Each Word'],
    ['toSentenceCase', 'Capitalize the first letter'],
    ['toSnakeCase', 'some_snake_case'],
    ['toCamelCase', 'someCamelCase'],
    ['extractEmail', 'First email address in the text'],
    ['extractUrl', 'First URL in the text'],
    ['extractDomain', 'Domain of a URL or email'],
    ['isEmail', 'true if the text is an email'],
    ['isUrl', 'true if the text is a URL'],
    ['isNumeric', 'true if the text is a number'],
    ['isEmpty', 'true if empty'],
    ['isNotEmpty', 'true if not empty'],
    ['toNumber', 'Convert to a number'],
    ['toBoolean', 'Convert to true/false'],
    ['toDateTime', 'Parse as a Luxon DateTime'],
    ['removeTags', 'Strip HTML tags'],
    ['replaceSpecialChars', 'é → e'],
    ['urlEncode', 'Encode for a URL'],
    ['urlDecode', 'Decode a URL value'],
    ['base64Encode', 'Encode as base64'],
    ['base64Decode', 'Decode base64'],
    ['hash', "hash('sha256')"],
    ['quote', 'Wrap in quotes'],
    ['parseJson', 'Parse JSON text'],
  ].map(([name, info]) => ({ name: name!, info: info!, on: 'string' as const })),
  ...[
    ['first', 'First element'],
    ['last', 'Last element'],
    ['sum', 'Sum of the numbers'],
    ['average', 'Average of the numbers'],
    ['min', 'Smallest value'],
    ['max', 'Largest value'],
    ['removeDuplicates', 'Unique values (optionally by key)'],
    ['compact', 'Remove empty values'],
    ['chunk', 'Split into groups of n'],
    ['pluck', 'Pick fields from objects'],
    ['randomItem', 'A random element'],
    ['difference', 'Elements not in the other array'],
    ['intersection', 'Elements in both arrays'],
    ['union', 'Elements of both arrays, unique'],
    ['smartJoin', 'Array of objects → object'],
    ['toJsonString', 'Convert to JSON text'],
  ].map(([name, info]) => ({ name: name!, info: info!, on: 'array' as const })),
  ...[
    ['round', 'round(2) → 2 decimals'],
    ['floor', 'Round down'],
    ['ceil', 'Round up'],
    ['abs', 'Absolute value'],
    ['isEven', 'true if even'],
    ['isOdd', 'true if odd'],
    ['format', "format('fr-FR')"],
    ['toDateTime', 'Milliseconds → DateTime'],
  ].map(([name, info]) => ({ name: name!, info: info!, on: 'number' as const })),
  ...[
    ['keys', 'Field names'],
    ['values', 'Field values'],
    ['hasField', "hasField('name')"],
    ['removeField', "removeField('name')"],
    ['compact', 'Remove empty fields'],
    ['merge', 'Merge another object'],
    ['toJsonString', 'Convert to JSON text'],
  ].map(([name, info]) => ({ name: name!, info: info!, on: 'object' as const })),
];

export const EXPRESSION_VARIABLES: Array<{ label: string; info: string; apply?: string }> = [
  { label: '$json', info: 'Data of the current item' },
  { label: '$binary', info: 'Files of the current item' },
  { label: '$input', info: 'All input items: .all(), .first(), .last(), .item' },
  { label: "$('Node name')", info: 'Output of another node', apply: "$('" },
  { label: '$node', info: 'Legacy: $node["Name"].json' },
  { label: '$items()', info: 'Items of a node: $items("Name")' },
  { label: '$prevNode', info: 'Name and output of the previous node' },
  { label: '$now', info: 'Current date & time (Luxon)' },
  { label: '$today', info: 'Today at midnight (Luxon)' },
  { label: '$workflow', info: 'id, name, active' },
  { label: '$execution', info: 'id, mode' },
  { label: '$vars', info: 'Global variables' },
  { label: '$env', info: 'Environment variables' },
  { label: '$itemIndex', info: 'Index of the current item' },
  { label: '$runIndex', info: 'How many times this node ran before' },
  { label: '$jmespath()', info: 'Query JSON: $jmespath(data, "a.b")' },
  { label: '$if()', info: '$if(condition, then, else)' },
  { label: '$ifEmpty()', info: '$ifEmpty(value, fallback)' },
  { label: '$min()', info: 'Smallest number' },
  { label: '$max()', info: 'Largest number' },
  { label: 'DateTime', info: 'Luxon DateTime class' },
];
