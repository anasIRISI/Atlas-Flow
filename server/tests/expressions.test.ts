import { describe, expect, it } from 'vitest';
import type { Item, RunData, WorkflowData } from '@flowforge/shared';
import { ExpressionError } from '../src/engine/errors.js';
import { ExpressionEngine, type ExpressionScope } from '../src/engine/expressions/engine.js';
import { splitTemplate } from '../src/engine/expressions/template.js';

const engine = new ExpressionEngine(200);

const workflow: WorkflowData = {
  id: 'wf1',
  name: 'Expressions',
  active: true,
  nodes: [
    { id: '1', name: 'Trigger', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: '2', name: 'Users', type: 'flowforge.code', typeVersion: 1, position: [200, 0], parameters: { mode: 'all' } },
    { id: '3', name: 'Current', type: 'flowforge.set', typeVersion: 1, position: [400, 0], parameters: { greeting: 'hi' } },
  ],
  connections: {},
};

const users: Item[] = [
  { json: { name: 'Ada', age: 36, tags: ['math', 'code'] }, pairedItem: { item: 0 } },
  { json: { name: 'Alan', age: 41, address: { city: 'London' } }, pairedItem: { item: 0 } },
];
// "Current" received users enriched by an intermediate step (pairedItem → Users item i).
const inputs: Item[][] = [users.map((u, i) => ({ json: { ...u.json, id: i + 1 }, pairedItem: { item: i } }))];

const runData: RunData = {
  Trigger: [{ startTime: 0, executionTime: 0, status: 'success', source: [], data: { main: [[{ json: {} }]] } }],
  Users: [
    {
      startTime: 0,
      executionTime: 0,
      status: 'success',
      source: [{ previousNode: 'Trigger', previousNodeOutput: 0, previousNodeRun: 0 }],
      data: { main: [users] },
    },
  ],
};

function scope(overrides: Partial<ExpressionScope> = {}): ExpressionScope {
  return {
    workflow,
    runData,
    nodeName: 'Current',
    inputs,
    sources: [{ previousNode: 'Users', previousNodeOutput: 0, previousNodeRun: 0 }],
    runIndex: 0,
    mode: 'manual',
    executionId: '42',
    timezone: 'Europe/Paris',
    variables: { company: 'FlowForge' },
    env: { HOME: '/home/test' },
    ...overrides,
  };
}

const ev = (expr: string, itemIndex = 0, s = scope()) => engine.evaluate(expr, s, itemIndex);

describe('template splitting', () => {
  it('splits text and code, respecting braces and quotes inside the code', () => {
    expect(splitTemplate('Hi {{ $json.name }}!')).toEqual([
      { kind: 'text', value: 'Hi ' },
      { kind: 'code', value: ' $json.name ' },
      { kind: 'text', value: '!' },
    ]);
    expect(splitTemplate('{{ {a: "}}"} }}')).toEqual([{ kind: 'code', value: ' {a: "}}"} ' }]);
  });

  it('reports an unclosed expression', () => {
    expect(() => ev('={{ $json.name ')).toThrow(/missing its closing \}\}/);
  });
});

describe('basic evaluation', () => {
  it('keeps the native type of a single expression', () => {
    expect(ev('={{ 1 + 1 }}')).toBe(2);
    expect(ev('={{ $json.age }}')).toBe(36);
    expect(ev('={{ $json.tags }}')).toEqual(['math', 'code']);
    expect(ev('={{ $json.age > 30 }}')).toBe(true);
    expect(ev('={{ $json.missing }}')).toBeUndefined();
  });

  it('interpolates text templates', () => {
    expect(ev('=Hello {{ $json.name }}, you are {{ $json.age }}')).toBe('Hello Ada, you are 36');
    expect(ev('=tags: {{ $json.tags }} / none: {{ $json.missing }}')).toBe('tags: ["math","code"] / none: ');
  });

  it('returns non-expressions unchanged', () => {
    expect(ev('plain {{ text }}')).toBe('plain {{ text }}');
    expect(ev('=no braces')).toBe('no braces');
  });

  it('evaluates per item', () => {
    expect(ev('={{ $json.name }}', 1)).toBe('Alan');
    expect(ev('={{ $itemIndex }}', 1)).toBe(1);
    expect(ev('={{ $runIndex }}')).toBe(0);
  });

  it('resolves expressions nested in objects and arrays', () => {
    const value = { a: '={{ $json.name }}', list: ['={{ $json.age * 2 }}', 'x'], keep: 5 };
    expect(engine.resolve(value, scope(), 0)).toEqual({ a: 'Ada', list: [72, 'x'], keep: 5 });
  });

  it('supports optional chaining, arrow functions and template literals', () => {
    expect(ev('={{ $json.address?.city ?? "none" }}', 0)).toBe('none');
    expect(ev('={{ $json.address?.city }}', 1)).toBe('London');
    expect(ev('={{ $json.tags.map(t => t.toUpperCase()).join("+") }}')).toBe('MATH+CODE');
    expect(ev('={{ `${$json.name}!` }}')).toBe('Ada!');
  });
});

describe('data access variables', () => {
  it('$input', () => {
    expect(ev('={{ $input.all().length }}')).toBe(2);
    expect(ev('={{ $input.first().json.name }}')).toBe('Ada');
    expect(ev('={{ $input.last().json.name }}')).toBe('Alan');
    expect(ev('={{ $input.item.json.id }}', 1)).toBe(2);
    expect(ev('={{ $input.params.greeting }}')).toBe('hi');
  });

  it("$('Node') with first/last/all and paired .item", () => {
    expect(ev("={{ $('Users').all().map(i => i.json.name) }}")).toEqual(['Ada', 'Alan']);
    expect(ev("={{ $('Users').first().json.age }}")).toBe(36);
    expect(ev("={{ $('Users').last().json.age }}")).toBe(41);
    expect(ev("={{ $('Users').item.json.name }}", 1)).toBe('Alan');
    expect(ev("={{ $('Users').itemMatching(0).json.name }}", 1)).toBe('Ada');
    expect(ev("={{ $('Users').isExecuted }}")).toBe(true);
    expect(ev("={{ $('Users').params.mode }}")).toBe('all');
  });

  it('$node["X"].json, $items() and $prevNode', () => {
    expect(ev('={{ $node["Users"].json.name }}', 1)).toBe('Alan');
    expect(ev('={{ $items("Users").length }}')).toBe(2);
    expect(ev('={{ $items().length }}')).toBe(2);
    expect(ev('={{ $prevNode.name }}')).toBe('Users');
  });

  it('gives clear errors for unknown or unexecuted nodes', () => {
    expect(() => ev("={{ $('Nope').first() }}")).toThrow(/Referenced node "Nope" doesn't exist/);
    expect(() => ev("={{ $('Current').first() }}")).toThrow(/hasn't been executed yet/);
    try {
      ev("={{ $('Nope').first() }}");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpressionError);
      expect((err as ExpressionError).hint).toMatch(/spelling/);
    }
  });

  it('$workflow, $execution, $vars, $env', () => {
    expect(ev('={{ $workflow.name }} #{{ $workflow.id }} {{ $workflow.active }}')).toBe('Expressions #wf1 true');
    expect(ev('={{ $execution.id }}/{{ $execution.mode }}')).toBe('42/test');
    expect(ev('={{ $vars.company }}')).toBe('FlowForge');
    expect(ev('={{ $env.HOME }}')).toBe('/home/test');
    expect(() => ev('={{ $env.HOME }}', 0, scope({ env: null }))).toThrow(/Access to \$env is disabled/);
    // The message and the hint of an error raised by a global ($env, $response…) arrive unchanged.
    let disabled: { message?: string; hint?: string } = {};
    try {
      ev('={{ $env.HOME }}', 0, scope({ env: null }));
    } catch (err) {
      disabled = err as { message?: string; hint?: string };
    }
    expect(disabled.message).toBe('Access to $env is disabled');
    expect(disabled.hint).toBe('An administrator can allow it in Settings.');
  });
});

describe('dates (Luxon)', () => {
  it('$now and $today are DateTime objects in the workflow timezone', () => {
    expect(ev('={{ $now.zoneName }}')).toBe('Europe/Paris');
    expect(ev('={{ $today.hour }}')).toBe(0);
    expect(ev('={{ $now.plus({ days: 1 }) > $now }}')).toBe(true);
    expect(ev('={{ DateTime.fromISO("2026-01-31").plus({ months: 1 }).toFormat("yyyy-MM-dd") }}')).toBe('2026-02-28');
  });

  it('returns DateTime results as ISO strings', () => {
    expect(ev('={{ DateTime.fromISO("2026-03-01T10:00:00", { zone: "utc" }) }}')).toBe('2026-03-01T10:00:00.000Z');
  });
});

describe('helpers and transformation functions', () => {
  it('$jmespath, $if, $ifEmpty, $min, $max', () => {
    expect(ev('={{ $jmespath($input.all(), "[].json.name") }}')).toEqual(['Ada', 'Alan']);
    expect(ev('={{ $if($json.age > 40, "senior", "junior") }}')).toBe('junior');
    expect(ev('={{ $ifEmpty($json.missing, "default") }}')).toBe('default');
    expect(ev('={{ $min(4, 2, 9) + $max(4, 2, 9) }}')).toBe(11);
  });

  it('string functions', () => {
    expect(ev('={{ "hello big world".toTitleCase() }}')).toBe('Hello Big World');
    expect(ev('={{ "Hello World".toSnakeCase() }}')).toBe('hello_world');
    expect(ev('={{ "contact: ada@example.com today".extractEmail() }}')).toBe('ada@example.com');
    expect(ev('={{ "https://www.example.com/x".extractDomain() }}')).toBe('example.com');
    expect(ev('={{ "ada@example.com".isEmail() }}')).toBe(true);
    expect(ev('={{ "42".toNumber() + 1 }}')).toBe(43);
    expect(ev('={{ "<b>bold</b>".removeTags() }}')).toBe('bold');
    expect(ev('={{ "abc".hash("md5") }}')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(ev('={{ "FlowForge".base64Encode().base64Decode() }}')).toBe('FlowForge');
    expect(() => ev('={{ "abc".toNumber() }}')).toThrow(/cannot be converted to a number/);
  });

  it('array, number and object functions', () => {
    expect(ev('={{ [1, 2, 3].sum() }}')).toBe(6);
    expect(ev('={{ [2, 4].average() }}')).toBe(3);
    expect(ev('={{ [1, 1, 2].removeDuplicates() }}')).toEqual([1, 2]);
    expect(ev('={{ [1, 2, 3, 4, 5].chunk(2) }}')).toEqual([[1, 2], [3, 4], [5]]);
    expect(ev('={{ $input.all().map(i => i.json).pluck("name") }}')).toEqual(['Ada', 'Alan']);
    expect(ev('={{ (3.14159).round(2) }}')).toBe(3.14);
    expect(ev('={{ (7).isOdd() }}')).toBe(true);
    expect(ev('={{ $json.isEmpty() }}')).toBe(false);
    expect(ev('={{ ({ a: 1, b: null }).compact() }}')).toEqual({ a: 1 });
    expect(ev('={{ $json.keys() }}')).toEqual(['name', 'age', 'tags', 'id']);
  });
});

describe('error messages', () => {
  it('reports syntax errors', () => {
    expect(() => ev('={{ $json.name +* 2 }}')).toThrow(/Invalid expression syntax/);
  });

  it('reports reference errors with a hint', () => {
    try {
      ev('={{ nope.value }}');
      expect.unreachable();
    } catch (err) {
      expect((err as ExpressionError).message).toMatch(/nope is not defined/);
      expect((err as ExpressionError).hint).toMatch(/\$json/);
      expect((err as ExpressionError).expression).toBe('nope.value');
    }
  });

  it('stops endless loops', () => {
    expect(() => ev('={{ (() => { while (true) {} })() }}')).toThrow(/longer than 200 ms/);
  });

  it('rejects statements', () => {
    expect(() => ev('={{ let x = 1 }}')).toThrow(/Invalid expression syntax|single JavaScript expression/);
  });
});

describe('sandbox escapes are rejected', () => {
  const attempts: Array<[string, RegExp]> = [
    ['={{ this.constructor.constructor("return process")() }}', /"constructor" is not allowed/],
    ['={{ $json.constructor }}', /"constructor" is not allowed/],
    ['={{ $json["constr" + "uctor"] }}', /"constructor" is not allowed/],
    ['={{ $json["constructor"] }}', /"constructor" is not allowed/],
    ['={{ (() => {}).constructor("return 1")() }}', /"constructor" is not allowed/],
    ['={{ $json.__proto__ }}', /"__proto__" is not allowed/],
    ['={{ $json[["__pro", "to__"].join("")] }}', /"__proto__" is not allowed/],
    ['={{ ({ __proto__: null }) }}', /"__proto__" is not allowed/],
    ['={{ process.env }}', /"process" is not allowed/],
    ['={{ require("fs") }}', /"require" is not allowed/],
    ['={{ globalThis.process }}', /"globalThis" is not allowed/],
    ['={{ Function("return process")() }}', /"Function" is not allowed/],
    ['={{ eval("1+1") }}', /"eval" is not allowed/],
    ['={{ Reflect.get($json, "constructor") }}', /"Reflect" is not allowed/],
    ['={{ Object.getPrototypeOf($json) }}', /"getPrototypeOf" is not allowed/],
    ['={{ import("fs") }}', /import\(\) " is not allowed|"import\(\)" is not allowed/],
    ['={{ __ffKey }}', /"__ffKey" is not allowed/],
  ];
  it.each(attempts)('%s', (expression, message) => {
    expect(() => ev(expression)).toThrow(message);
  });

  it('blocks keys hidden behind a toString()', () => {
    expect(() => ev('={{ $json[{ toString() { return "constructor" } }] }}')).toThrow(/"constructor" is not allowed/);
  });

  it('lets data use helper names as normal fields', () => {
    expect(ev('={{ ({ ...$json, values: [1], keys: "k" }).values }}')).toEqual([1]);
    expect(ev('={{ Duration.fromObject({ hours: 2 }).as("minutes") }}')).toBe(120);
  });

  it('cannot reach the host even through errors thrown by the bridge', () => {
    // The error comes from the host bridge but is re-created inside the sandbox.
    expect(() => ev("={{ (() => { try { $('Nope').first() } catch (e) { return e.constructor } })() }}")).toThrow(
      /"constructor" is not allowed/,
    );
    expect(ev("={{ (() => { try { $('Nope').first() } catch (e) { return e instanceof Error } })() }}")).toBe(true);
  });

  it('cannot pollute shared prototypes for later evaluations', () => {
    expect(() => ev('={{ Object.prototype.polluted = 1 }}')).toThrow(/Cannot add property|not extensible|read only/);
    expect(() => ev('={{ Array.prototype.sum = () => 99 }}')).toThrow(/Cannot change built-in method sum/);
    expect(ev('={{ [1, 2].sum() }}')).toBe(3);
    expect(ev('={{ ({}).polluted }}')).toBeUndefined();
  });

  it('cannot create globals or leak state between evaluations', () => {
    expect(() => ev('={{ leaked = 1 }}')).toThrow(/leaked is not defined/);
    expect(ev('={{ typeof leaked }}')).toBe('undefined');
    // Host-only APIs simply do not exist inside the sandbox.
    expect(ev('={{ typeof fetch }}')).toBe('undefined');
    expect(ev('={{ typeof structuredClone }}')).toBe('undefined');
  });

  it('returns plain host data (no sandbox objects leak out)', () => {
    const value = ev('={{ { a: [1, { b: 2 }] } }}') as { a: unknown[] };
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(value.a)).toBe(Array.prototype);
  });

  it('does not let one expression change $json for the next one', () => {
    expect(ev('={{ ($json.name = "Mallory", $json.name) }}')).toBe('Mallory');
    expect(ev('={{ $json.name }}')).toBe('Ada');
    expect(inputs[0]![0]!.json.name).toBe('Ada');
  });
});
