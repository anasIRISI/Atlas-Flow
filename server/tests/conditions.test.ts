import { describe, expect, it } from 'vitest';
import type { ConditionType, ConditionsValue } from '@flowforge/shared';
import { evaluateConditions } from '../src/engine/conditions.js';

const one = (type: ConditionType, operation: string, leftValue: unknown, rightValue?: unknown): ConditionsValue => ({
  conditions: [{ leftValue, rightValue, operator: { type, operation } }],
  combinator: 'and',
});
const check = (type: ConditionType, operation: string, left: unknown, right?: unknown, loose = false) =>
  evaluateConditions(one(type, operation, left, right), { looseTypeValidation: loose });

describe('condition engine', () => {
  it('string operators', () => {
    expect(check('string', 'equals', 'Ada', 'Ada')).toBe(true);
    expect(check('string', 'notEquals', 'Ada', 'ada')).toBe(true);
    expect(check('string', 'contains', 'FlowForge', 'Forge')).toBe(true);
    expect(check('string', 'notContains', 'FlowForge', 'n8n')).toBe(true);
    expect(check('string', 'startsWith', 'FlowForge', 'Flow')).toBe(true);
    expect(check('string', 'endsWith', 'FlowForge', 'Forge')).toBe(true);
    expect(check('string', 'regex', 'order-1234', '^order-\\d+$')).toBe(true);
    expect(check('string', 'regex', 'ORDER-1', '/order-\\d/i')).toBe(true);
    expect(check('string', 'notRegex', 'abc', '\\d')).toBe(true);
  });

  it('case-insensitive comparison', () => {
    const value = one('string', 'equals', 'ADA', 'ada');
    expect(evaluateConditions(value)).toBe(false);
    expect(evaluateConditions(value, { ignoreCase: true })).toBe(true);
    expect(evaluateConditions({ ...value, options: { caseSensitive: false } })).toBe(true);
  });

  it('number operators (right value typed as text is converted)', () => {
    expect(check('number', 'gt', 20, '18')).toBe(true);
    expect(check('number', 'lt', 5, 10)).toBe(true);
    expect(check('number', 'gte', 10, 10)).toBe(true);
    expect(check('number', 'lte', 11, 10)).toBe(false);
    expect(check('number', 'equals', 3, '3')).toBe(true);
  });

  it('dateTime operators accept ISO strings', () => {
    expect(check('dateTime', 'after', '2026-05-01T00:00:00Z', '2026-04-30T23:59:59Z')).toBe(true);
    expect(check('dateTime', 'after', '2026-05-01T00:30:00+02:00', '2026-04-30T23:00:00Z')).toBe(false);
    expect(check('dateTime', 'before', '2026-01-01T00:00:00Z', '2026-01-02')).toBe(true);
    expect(check('dateTime', 'equals', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00Z')).toBe(true);
  });

  it('boolean, array and object operators', () => {
    expect(check('boolean', 'true', true)).toBe(true);
    expect(check('boolean', 'false', true)).toBe(false);
    expect(check('array', 'contains', ['a', 'b'], 'b')).toBe(true);
    expect(check('array', 'lengthGt', [1, 2, 3], 2)).toBe(true);
    expect(check('array', 'empty', [])).toBe(true);
    expect(check('object', 'notEmpty', { a: 1 })).toBe(true);
    expect(check('object', 'empty', {})).toBe(true);
  });

  it('exists / empty work for every type and for missing values', () => {
    expect(check('string', 'exists', undefined)).toBe(false);
    expect(check('number', 'notExists', null)).toBe(true);
    expect(check('string', 'empty', '')).toBe(true);
    expect(check('string', 'notEmpty', 'x')).toBe(true);
    // A missing value never matches a comparison, but matches its negation.
    expect(check('number', 'gt', undefined, 1)).toBe(false);
    expect(check('string', 'notEquals', undefined, 'x')).toBe(true);
  });

  it('strict type validation explains the problem', () => {
    expect(() => check('number', 'gt', '25', 18)).toThrow("Wrong type: '25' is a string but was expecting a number");
    try {
      check('number', 'gt', '25', 18);
    } catch (err) {
      expect((err as { hint?: string }).hint).toMatch(/Convert types where required/);
    }
    expect(() => check('boolean', 'true', 'yes')).toThrow(/expecting a boolean/);
  });

  it('loose type validation converts values', () => {
    expect(check('number', 'gt', '25', 18, true)).toBe(true);
    expect(check('boolean', 'true', 'yes', undefined, true)).toBe(true);
    expect(check('array', 'contains', '["x","y"]', 'y', true)).toBe(true);
    expect(check('string', 'equals', 42, '42', true)).toBe(true);
    expect(() => check('number', 'gt', 'abc', 1, true)).toThrow(/expecting a number/);
  });

  it('AND / OR combinators', () => {
    const conditions = [
      { leftValue: 5, rightValue: 1, operator: { type: 'number' as const, operation: 'gt' } },
      { leftValue: 5, rightValue: 10, operator: { type: 'number' as const, operation: 'gt' } },
    ];
    expect(evaluateConditions({ conditions, combinator: 'and' })).toBe(false);
    expect(evaluateConditions({ conditions, combinator: 'or' })).toBe(true);
    expect(evaluateConditions({ conditions: [], combinator: 'and' })).toBe(true);
  });

  it('reports invalid regular expressions clearly', () => {
    expect(() => check('string', 'regex', 'abc', '([')).toThrow(/Invalid regular expression/);
  });
});
