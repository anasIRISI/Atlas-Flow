import { describe, expect, it } from 'vitest';
import type { NodeProperty } from '@flowforge/shared';
import { isVisible, setIn, withDefaults } from '../src/editor/params/display';
import { fromExpression, jsonPath, toExpression, withDroppedField } from '../src/lib/expressions';
import { resolveSubtitle } from '../src/lib/node-types';

const prop = (displayOptions: NodeProperty['displayOptions']): NodeProperty => ({ name: 'x', displayName: 'X', type: 'string', default: '', displayOptions });

describe('displayOptions', () => {
  it('show / hide rules, with defaults and "/root" references', () => {
    expect(isVisible(prop({ show: { mode: ['raw'] } }), { mode: 'raw' }, {})).toBe(true);
    expect(isVisible(prop({ show: { mode: ['raw'] } }), { mode: 'manual' }, {})).toBe(false);
    // Multi-select values (arrays) match when one of their entries is listed.
    expect(isVisible(prop({ show: { include: ['daily', 'hourly'] } }), { include: ['current', 'daily'] }, {})).toBe(true);
    expect(isVisible(prop({ show: { include: ['hourly'] } }), { include: ['current', 'daily'] }, {})).toBe(false);
    expect(isVisible(prop({ hide: { include: ['hourly'] } }), { include: ['hourly'] }, {})).toBe(false);
    expect(isVisible(prop({ show: { mode: ['combine'], combineBy: ['fields'] } }), { mode: 'combine', combineBy: 'fields' }, {})).toBe(true);
    expect(isVisible(prop({ hide: { mode: ['raw'] } }), { mode: 'raw' }, {})).toBe(false);
    expect(isVisible(prop({ show: { renameOutput: [true] } }), { renameOutput: true }, {})).toBe(true);
    expect(isVisible(prop({ show: { '/mode': ['rules'] } }), {}, { mode: 'rules' })).toBe(true);
    const props: NodeProperty[] = [{ name: 'mode', displayName: 'Mode', type: 'options', default: 'manual' }];
    expect(withDefaults(props, {})).toEqual({ mode: 'manual' });
  });

  it('setIn updates nested values immutably and removes undefined keys', () => {
    const v = { a: { b: [{ c: 1 }] } };
    const out = setIn(v, ['a', 'b', 0, 'c'], 2);
    expect(out).toEqual({ a: { b: [{ c: 2 }] } });
    expect(v.a.b[0]!.c).toBe(1);
    expect(setIn({ a: 1, b: 2 }, ['a'], undefined)).toEqual({ b: 2 });
  });
});

describe('expression helpers', () => {
  it('converts between fixed values and expressions', () => {
    expect(toExpression('hello')).toBe('=hello');
    expect(toExpression(42)).toBe('={{ 42 }}');
    expect(toExpression('')).toBe('=');
    expect(fromExpression('={{ 42 }}', 'number')).toBe(42);
    expect(fromExpression('=hello', 'string')).toBe('hello');
    expect(fromExpression('={{ $json.a }}', 'string')).toBe('');
  });

  it('dropping a field creates or extends an expression', () => {
    expect(withDroppedField('', '{{ $json.age }}')).toBe('={{ $json.age }}');
    expect(withDroppedField('Hi', '{{ $json.name }}')).toBe('=Hi {{ $json.name }}');
    expect(withDroppedField('=Hi', '{{ $json.name }}')).toBe('=Hi {{ $json.name }}');
  });

  it('builds safe JSON paths', () => {
    expect(jsonPath('$json', ['address', 'city'])).toBe('$json.address.city');
    expect(jsonPath('$json', ['my field', 0, 'x'])).toBe("$json['my field'][0].x");
  });

  it('resolves node subtitles from parameters and option labels', () => {
    const type = {
      subtitle: 'mode: {{mode}}',
      properties: [{ name: 'mode', displayName: 'Mode', type: 'options', default: 'rules', options: [{ name: 'Rules', value: 'rules' }] }],
    } as never;
    expect(resolveSubtitle(type, { parameters: {} } as never)).toBe('mode: Rules');
    expect(resolveSubtitle(type, { parameters: { mode: '={{ 1 }}' } } as never)).toBe('mode: expression');
  });
});
