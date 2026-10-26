import { DateTime } from 'luxon';
import type { Condition, ConditionsValue, ConditionType } from '@flowforge/shared';
import { NodeOperationError } from './errors.js';

export interface EvaluateOptions {
  /** Convert types where required ("loose" validation). Overrides the value stored in the conditions. */
  looseTypeValidation?: boolean;
  /** Compare strings case-insensitively. */
  ignoreCase?: boolean;
  itemIndex?: number;
}

const NO_VALUE_OPS = new Set(['exists', 'notExists', 'empty', 'notEmpty']);

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (value instanceof Date) return 'a date';
  const t = typeof value;
  return t === 'object' ? 'an object' : `a ${t}`;
}

function preview(value: unknown): string {
  const s = typeof value === 'string' ? `'${value}'` : JSON.stringify(value);
  return s && s.length > 40 ? `${s.slice(0, 37)}…` : String(s);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

function toMillis(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    let dt = DateTime.fromISO(value, { setZone: true });
    if (!dt.isValid) dt = DateTime.fromRFC2822(value);
    if (!dt.isValid) dt = DateTime.fromSQL(value);
    if (dt.isValid) return dt.toMillis();
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** Converts a value to the operator's type. Returns `undefined` + ok=false when impossible. */
function convert(value: unknown, type: ConditionType, loose: boolean): { ok: boolean; value: unknown } {
  switch (type) {
    case 'string':
      if (typeof value === 'string') return { ok: true, value };
      if (!loose) return { ok: false, value };
      return { ok: true, value: typeof value === 'object' ? JSON.stringify(value) : String(value) };
    case 'number': {
      if (typeof value === 'number' && !Number.isNaN(value)) return { ok: true, value };
      if (!loose) return { ok: false, value };
      if (typeof value === 'boolean') return { ok: true, value: value ? 1 : 0 };
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      return Number.isNaN(n) ? { ok: false, value } : { ok: true, value: n };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      if (!loose) return { ok: false, value };
      const s = String(value).trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(s)) return { ok: true, value: true };
      if (['false', '0', 'no', 'off'].includes(s)) return { ok: true, value: false };
      return { ok: false, value };
    }
    case 'dateTime': {
      // Dates usually arrive as ISO strings, so strings are accepted even in strict mode.
      if (typeof value === 'number' && !loose) return { ok: false, value };
      const ms = toMillis(value);
      return ms === undefined ? { ok: false, value } : { ok: true, value: ms };
    }
    case 'array':
      if (Array.isArray(value)) return { ok: true, value };
      if (loose && typeof value === 'string') {
        try {
          const parsed: unknown = JSON.parse(value);
          if (Array.isArray(parsed)) return { ok: true, value: parsed };
        } catch {
          /* not JSON */
        }
      }
      return { ok: false, value };
    case 'object':
      if (isPlainObject(value)) return { ok: true, value };
      if (loose && typeof value === 'string') {
        try {
          const parsed: unknown = JSON.parse(value);
          if (isPlainObject(parsed)) return { ok: true, value: parsed };
        } catch {
          /* not JSON */
        }
      }
      return { ok: false, value };
  }
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function toRegex(pattern: string, ignoreCase: boolean): RegExp {
  const literal = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
  try {
    if (literal) return new RegExp(literal[1]!, literal[2]!.includes('i') || !ignoreCase ? literal[2] : `${literal[2]}i`);
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (err) {
    throw new NodeOperationError(`Invalid regular expression: ${pattern}`, { description: (err as Error).message });
  }
}

const deepEqual = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function evaluateCondition(condition: Condition, loose: boolean, ignoreCase: boolean, itemIndex?: number): boolean {
  const { type, operation } = condition.operator;
  const left = condition.leftValue;

  if (operation === 'exists') return left !== undefined && left !== null;
  if (operation === 'notExists') return left === undefined || left === null;
  if (operation === 'empty') return isEmpty(left);
  if (operation === 'notEmpty') return !isEmpty(left);
  if (left === undefined || left === null) return operation.startsWith('not');

  const l = convert(left, type, loose);
  if (!l.ok) {
    throw new NodeOperationError(`Wrong type: ${preview(left)} is ${describeType(left)} but was expecting a ${type}`, {
      itemIndex,
      hint: "Try changing the type of comparison, or enable 'Convert types where required'.",
    });
  }
  // The right value is usually typed by hand ("18"), so it is always converted leniently.
  const rightNeeded = !NO_VALUE_OPS.has(operation) && !['true', 'false'].includes(operation);
  let right: unknown = condition.rightValue;
  if (rightNeeded && type !== 'array' && type !== 'object' && !operation.startsWith('length')) {
    const r = convert(condition.rightValue, type, true);
    if (!r.ok) {
      throw new NodeOperationError(`The value to compare with (${preview(condition.rightValue)}) is not a valid ${type}`, { itemIndex });
    }
    right = r.value;
  }

  const lv = l.value;
  switch (type) {
    case 'string': {
      const a = ignoreCase ? String(lv).toLowerCase() : String(lv);
      const b = ignoreCase ? String(right).toLowerCase() : String(right);
      switch (operation) {
        case 'equals': return a === b;
        case 'notEquals': return a !== b;
        case 'contains': return a.includes(b);
        case 'notContains': return !a.includes(b);
        case 'startsWith': return a.startsWith(b);
        case 'notStartsWith': return !a.startsWith(b);
        case 'endsWith': return a.endsWith(b);
        case 'notEndsWith': return !a.endsWith(b);
        case 'regex': return toRegex(String(right), ignoreCase).test(String(lv));
        case 'notRegex': return !toRegex(String(right), ignoreCase).test(String(lv));
      }
      break;
    }
    case 'number':
    case 'dateTime': {
      const a = lv as number;
      const b = right as number;
      switch (operation) {
        case 'equals': return a === b;
        case 'notEquals': return a !== b;
        case 'gt': case 'after': return a > b;
        case 'lt': case 'before': return a < b;
        case 'gte': case 'afterOrEquals': return a >= b;
        case 'lte': case 'beforeOrEquals': return a <= b;
      }
      break;
    }
    case 'boolean':
      switch (operation) {
        case 'true': return lv === true;
        case 'false': return lv === false;
        case 'equals': return lv === right;
        case 'notEquals': return lv !== right;
      }
      break;
    case 'array': {
      const arr = lv as unknown[];
      const n = Number(right);
      switch (operation) {
        case 'contains': return arr.some((v) => deepEqual(v, right) || (loose && String(v) === String(right)));
        case 'notContains': return !arr.some((v) => deepEqual(v, right) || (loose && String(v) === String(right)));
        case 'lengthEquals': return arr.length === n;
        case 'lengthNotEquals': return arr.length !== n;
        case 'lengthGt': return arr.length > n;
        case 'lengthLt': return arr.length < n;
        case 'lengthGte': return arr.length >= n;
        case 'lengthLte': return arr.length <= n;
      }
      break;
    }
    case 'object':
      break;
  }
  throw new NodeOperationError(`Unknown condition operation "${operation}" for type ${type}`, { itemIndex });
}

/** Evaluates a resolved conditions value (expressions already replaced by their values). */
export function evaluateConditions(value: ConditionsValue, options: EvaluateOptions = {}): boolean {
  const conditions = (value?.conditions ?? []).filter((c) => c && c.operator);
  if (conditions.length === 0) return true;
  const loose = options.looseTypeValidation ?? value.options?.typeValidation === 'loose';
  const ignoreCase = options.ignoreCase ?? value.options?.caseSensitive === false;
  const results = (c: Condition) => evaluateCondition(c, loose, ignoreCase, options.itemIndex);
  return value.combinator === 'or' ? conditions.some(results) : conditions.every(results);
}
