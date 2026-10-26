// Condition model used by IF / Switch / Filter (same shape as n8n's "filter" parameter).

export type ConditionType = 'string' | 'number' | 'dateTime' | 'boolean' | 'array' | 'object';

export interface ConditionOperator {
  type: ConditionType;
  operation: string;
  /** True when the operator needs no right value (exists, is empty, is true, …). */
  singleValue?: boolean;
}

export interface Condition {
  id?: string;
  leftValue: unknown;
  rightValue?: unknown;
  operator: ConditionOperator;
}

export interface ConditionsValue {
  options?: { caseSensitive?: boolean; typeValidation?: 'strict' | 'loose' };
  conditions: Condition[];
  combinator: 'and' | 'or';
}

export interface OperatorInfo {
  operation: string;
  name: string;
  singleValue?: boolean;
}

const common: OperatorInfo[] = [
  { operation: 'exists', name: 'exists', singleValue: true },
  { operation: 'notExists', name: 'does not exist', singleValue: true },
];

/** Every operator the condition builder offers, per data type. */
export const CONDITION_OPERATORS: Record<ConditionType, OperatorInfo[]> = {
  string: [
    ...common,
    { operation: 'empty', name: 'is empty', singleValue: true },
    { operation: 'notEmpty', name: 'is not empty', singleValue: true },
    { operation: 'equals', name: 'is equal to' },
    { operation: 'notEquals', name: 'is not equal to' },
    { operation: 'contains', name: 'contains' },
    { operation: 'notContains', name: 'does not contain' },
    { operation: 'startsWith', name: 'starts with' },
    { operation: 'notStartsWith', name: 'does not start with' },
    { operation: 'endsWith', name: 'ends with' },
    { operation: 'notEndsWith', name: 'does not end with' },
    { operation: 'regex', name: 'matches regex' },
    { operation: 'notRegex', name: 'does not match regex' },
  ],
  number: [
    ...common,
    { operation: 'equals', name: 'is equal to' },
    { operation: 'notEquals', name: 'is not equal to' },
    { operation: 'gt', name: 'is greater than' },
    { operation: 'lt', name: 'is less than' },
    { operation: 'gte', name: 'is greater than or equal to' },
    { operation: 'lte', name: 'is less than or equal to' },
  ],
  dateTime: [
    ...common,
    { operation: 'equals', name: 'is equal to' },
    { operation: 'notEquals', name: 'is not equal to' },
    { operation: 'after', name: 'is after' },
    { operation: 'before', name: 'is before' },
    { operation: 'afterOrEquals', name: 'is after or equal to' },
    { operation: 'beforeOrEquals', name: 'is before or equal to' },
  ],
  boolean: [
    ...common,
    { operation: 'true', name: 'is true', singleValue: true },
    { operation: 'false', name: 'is false', singleValue: true },
    { operation: 'equals', name: 'is equal to' },
    { operation: 'notEquals', name: 'is not equal to' },
  ],
  array: [
    ...common,
    { operation: 'empty', name: 'is empty', singleValue: true },
    { operation: 'notEmpty', name: 'is not empty', singleValue: true },
    { operation: 'contains', name: 'contains' },
    { operation: 'notContains', name: 'does not contain' },
    { operation: 'lengthEquals', name: 'length equal to' },
    { operation: 'lengthNotEquals', name: 'length not equal to' },
    { operation: 'lengthGt', name: 'length greater than' },
    { operation: 'lengthLt', name: 'length less than' },
    { operation: 'lengthGte', name: 'length greater than or equal to' },
    { operation: 'lengthLte', name: 'length less than or equal to' },
  ],
  object: [
    ...common,
    { operation: 'empty', name: 'is empty', singleValue: true },
    { operation: 'notEmpty', name: 'is not empty', singleValue: true },
  ],
};

export function defaultConditions(): ConditionsValue {
  return {
    options: { caseSensitive: true, typeValidation: 'strict' },
    conditions: [{ leftValue: '', rightValue: '', operator: { type: 'string', operation: 'equals' } }],
    combinator: 'and',
  };
}
