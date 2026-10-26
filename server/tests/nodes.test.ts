import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { JsonObject } from '@flowforge/shared';
import { BinaryStore } from '../src/engine/binary-store.js';
import { getCodeSandbox } from '../src/engine/code/sandbox.js';
import { defineNode } from '../src/engine/types.js';
import { codeLimits } from '../src/nodes/transform/code.node.js';
import { NodeRegistry } from '../src/nodes/registry.js';
import { emit, getTestRegistry, out, run, wf } from './engine-helpers.js';

const people = [
  { id: 1, name: 'Ada', age: 36 },
  { id: 2, name: 'Alan', age: 41 },
  { id: 3, name: 'Grace', age: 85 },
];

/** Trigger → People → node under test */
const withPeople = (type: string, params: JsonObject, extra = {}) =>
  wf([['T', 'manual'], ['People', 'test.emit', emit(people)], ['Node', type, params, extra]], [['T', 'People'], ['People', 'Node']]);

afterAll(async () => {
  await getCodeSandbox().close();
});

describe('node registry', () => {
  it('auto-loads every node file with a valid description', async () => {
    const registry = await getTestRegistry();
    const types = registry.list().map((n) => n.type);
    for (const type of ['manualTrigger', 'set', 'if', 'switch', 'filter', 'merge', 'noOp', 'code', 'stopAndError', 'splitInBatches', 'limit', 'sort', 'stickyNote']) {
      expect(types).toContain(`flowforge.${type}`);
    }
    expect(types.some((t) => t.startsWith('test.'))).toBe(false); // hidden nodes are not listed
    expect(registry.list().find((n) => n.type === 'flowforge.if')?.properties.length).toBeGreaterThan(0);
  });

  it('uses only simple {{parameter}} placeholders in subtitles (the canvas cannot evaluate code there)', async () => {
    const registry = await getTestRegistry();
    for (const info of registry.list()) {
      const subtitle = (info as { subtitle?: string }).subtitle ?? '';
      expect(subtitle, info.type).toMatch(/^(?:[^{}]|\{\{\s*[\w.]+\s*\}\})*$/);
    }
  });

  it('rejects invalid node files with a readable error', () => {
    const registry = new NodeRegistry();
    const valid = defineNode({
      description: {
        type: 'flowforge.ok', displayName: 'OK', description: 'ok', icon: 'lucide:x', group: 'transform', version: 1,
        defaults: { name: 'OK' }, inputs: [{ type: 'main' }], outputs: [{ type: 'main' }],
      },
      properties: [],
    });
    registry.register(valid);
    expect(() => registry.register(valid)).toThrow(/Duplicate node type "flowforge.ok"/);
    expect(() => registry.register({ ...valid, description: { ...valid.description, type: 'bad type' } })).toThrow(/type must look like/);
    expect(() =>
      registry.register({ ...valid, description: { ...valid.description, type: 'flowforge.p' }, properties: [{ name: 'a b', displayName: 'x', type: 'string', default: '' }] }),
    ).toThrow(/property names must be identifiers/);
    expect(() => registry.register({ ...valid, description: { ...valid.description, type: 'flowforge.d', dynamicOutputs: true } })).toThrow(/no outputs\(\) function/);
  });

  it('computes dynamic outputs and the extra error output', async () => {
    const registry = await getTestRegistry();
    const node = (type: string, parameters: JsonObject, extra = {}) => ({ id: '1', name: 'n', type, typeVersion: 1, position: [0, 0] as [number, number], parameters, ...extra });
    expect(registry.outputsFor(node('flowforge.filter', {})).length).toBe(1);
    expect(registry.outputsFor(node('flowforge.filter', { keepDiscarded: true })).map((o) => o.displayName)).toEqual(['Kept', 'Discarded']);
    expect(registry.outputsFor(node('flowforge.switch', { mode: 'expression', numberOutputs: 3 })).length).toBe(3);
    expect(registry.outputsFor(node('flowforge.noOp', {}, { onError: 'continueErrorOutput' })).map((o) => o.displayName)).toEqual([undefined, 'error']);
  });
});

describe('Edit Fields (Set)', () => {
  const assign = (assignments: Array<{ name: string; value: unknown; type?: string }>, extra: JsonObject = {}) => ({
    assignments: { assignments },
    ...extra,
  });

  it('sets typed fields from expressions, with dot notation', async () => {
    const r = await run(
      withPeople(
        'set',
        assign([
          { name: 'user.name', value: '={{ $json.name.toUpperCase() }}', type: 'string' },
          { name: 'ageText', value: '={{ $json.age }}', type: 'string' },
          { name: 'next', value: '={{ $json.age + 1 }}', type: 'number' },
          { name: 'tags', value: '["a","b"]', type: 'array' },
          { name: 'vip', value: 'true', type: 'boolean' },
        ]),
      ),
    );
    expect(out(r, 'Node')[0]).toEqual({ user: { name: 'ADA' }, ageText: '36', next: 37, tags: ['a', 'b'], vip: true });
  });

  it('keeps other fields when asked (all / selected / except)', async () => {
    const add = [{ name: 'x', value: 1, type: 'number' }];
    expect(out(await run(withPeople('set', assign(add, { includeOtherFields: true }))), 'Node')[0]).toEqual({ ...people[0], x: 1 });
    expect(out(await run(withPeople('set', assign(add, { includeOtherFields: true, include: 'selected', includeFields: 'name' }))), 'Node')[0]).toEqual({ name: 'Ada', x: 1 });
    expect(out(await run(withPeople('set', assign(add, { includeOtherFields: true, include: 'except', excludeFields: 'age, id' }))), 'Node')[0]).toEqual({ name: 'Ada', x: 1 });
  });

  it('reports conversion errors, or ignores them when asked', async () => {
    const bad = assign([{ name: 'n', value: 'abc', type: 'number' }]);
    const r = await run(withPeople('set', bad));
    expect(r.error?.message).toBe('Value of "n" ("abc") cannot be converted to number');
    const ok = await run(withPeople('set', { ...bad, options: { ignoreConversionErrors: true } }));
    expect(out(ok, 'Node')[0]).toEqual({ n: 'abc' });
  });

  it('JSON mode builds the item from (expression) JSON and explains invalid JSON', async () => {
    const r = await run(withPeople('set', { mode: 'raw', jsonOutput: '={ "who": "{{ $json.name }}", "double": {{ $json.age * 2 }} }' }));
    expect(out(r, 'Node')[1]).toEqual({ who: 'Alan', double: 82 });
    const bad = await run(withPeople('set', { mode: 'raw', jsonOutput: '{ who: 1 }' }));
    expect(bad.error?.message).toBe('The JSON output is not valid JSON');
  });
});

describe('Switch, Filter, Limit, Sort, Stop and Error', () => {
  const rule = (op: string, right: unknown, key?: string) => ({
    conditions: { conditions: [{ leftValue: '={{ $json.age }}', rightValue: right, operator: { type: 'number', operation: op } }], combinator: 'and' },
    renameOutput: Boolean(key),
    outputKey: key ?? '',
  });

  it('Switch (rules) routes to the first matching rule, with an extra fallback output', async () => {
    const r = await run(withPeople('switch', { rules: { values: [rule('lt', 40), rule('lt', 50)] }, options: { fallbackOutput: 'extra' } }));
    expect(out(r, 'Node', 0).map((j) => j.name)).toEqual(['Ada']);
    expect(out(r, 'Node', 1).map((j) => j.name)).toEqual(['Alan']);
    expect(out(r, 'Node', 2).map((j) => j.name)).toEqual(['Grace']);
  });

  it('Switch can send an item to all matching outputs', async () => {
    const r = await run(withPeople('switch', { rules: { values: [rule('lt', 40), rule('lt', 50)] }, options: { allMatchingOutputs: true } }));
    expect(out(r, 'Node', 1).map((j) => j.name)).toEqual(['Ada', 'Alan']);
  });

  it('Switch (expression) uses the returned output index and checks the range', async () => {
    const r = await run(withPeople('switch', { mode: 'expression', numberOutputs: 2, output: '={{ $json.age > 40 ? 1 : 0 }}' }));
    expect(out(r, 'Node', 1).map((j) => j.name)).toEqual(['Alan', 'Grace']);
    const bad = await run(withPeople('switch', { mode: 'expression', numberOutputs: 2, output: '={{ 5 }}' }));
    expect(bad.error?.message).toBe('Output index 5 is out of range (0–1)');
  });

  it('Filter keeps matching items and can output the discarded ones', async () => {
    const conditions = { conditions: [{ leftValue: '={{ $json.name }}', rightValue: 'a', operator: { type: 'string', operation: 'startsWith' } }], combinator: 'and' };
    const r = await run(withPeople('filter', { conditions, keepDiscarded: true, options: { ignoreCase: true } }));
    expect(out(r, 'Node', 0).map((j) => j.name)).toEqual(['Ada', 'Alan']);
    expect(out(r, 'Node', 1).map((j) => j.name)).toEqual(['Grace']);
  });

  it('Limit keeps the first or last items', async () => {
    expect(out(await run(withPeople('limit', { maxItems: 2 })), 'Node').map((j) => j.id)).toEqual([1, 2]);
    expect(out(await run(withPeople('limit', { maxItems: 2, keep: 'lastItems' })), 'Node').map((j) => j.id)).toEqual([2, 3]);
  });

  it('Sort orders by several fields and puts missing values last', async () => {
    const r = await run(
      wf(
        [['T', 'manual'], ['Data', 'test.emit', emit([{ g: 'b', n: 2 }, { g: 'a', n: 10 }, { n: 1 }, { g: 'a', n: 9 }])], ['Sort', 'sort', { sortFieldsUi: { sortField: [{ fieldName: 'g', order: 'ascending' }, { fieldName: 'n', order: 'descending' }] } }]],
        [['T', 'Data'], ['Data', 'Sort']],
      ),
    );
    expect(out(r, 'Sort')).toEqual([{ g: 'a', n: 10 }, { g: 'a', n: 9 }, { g: 'b', n: 2 }, { n: 1 }]);
    const desc = await run(
      wf(
        [['T', 'manual'], ['Data', 'test.emit', emit([{ n: 1 }, {}, { n: 3 }])], ['Sort', 'sort', { sortFieldsUi: { sortField: [{ fieldName: 'n', order: 'descending' }] } }]],
        [['T', 'Data'], ['Data', 'Sort']],
      ),
    );
    expect(out(desc, 'Sort')).toEqual([{ n: 3 }, { n: 1 }, {}]);
  });

  it('Stop and Error stops the workflow with the given message', async () => {
    const r = await run(withPeople('stop', { errorMessage: '=Bad user {{ $json.name }}' }));
    expect(r.status).toBe('error');
    expect(r.error).toMatchObject({ message: 'Bad user Ada', node: 'Node' });
  });
});

describe('Code node (QuickJS sandbox)', () => {
  const code = (jsCode: string, mode = 'runOnceForAllItems') =>
    withPeople('code', mode === 'runOnceForAllItems' ? { mode, jsCode } : { mode, jsCodeEachItem: jsCode });

  it('runs once for all items', async () => {
    const r = await run(code('return $input.all().filter(i => i.json.age > 40).map(i => ({ json: { who: i.json.name } }));'));
    expect(r.status).toBe('success');
    expect(out(r, 'Node')).toEqual([{ who: 'Alan' }, { who: 'Grace' }]);
  });

  it('runs once for each item and accepts plain objects', async () => {
    const r = await run(code('return { ...$json, initials: $json.name[0], index: $itemIndex };', 'runOnceForEachItem'));
    expect(out(r, 'Node')[2]).toEqual({ ...people[2], initials: 'G', index: 2 });
    expect(r.runData.Node![0]!.data.main[0]![2]!.pairedItem).toEqual({ item: 2 });
  });

  it('supports async/await, console.log and $("Node")', async () => {
    const r = await run(
      code(`const first = await Promise.resolve($('People').first().json.name);
console.log('first is', first, { n: $('People').all().length });
return [{ json: { first } }];`),
    );
    expect(out(r, 'Node')).toEqual([{ first: 'Ada' }]);
    expect(r.runData.Node![0]!.logs).toEqual(['first is Ada {"n":3}']);
  });

  it('gives errors with the line number of your code', async () => {
    const r = await run(code('const a = 1;\nconst b = null;\nreturn b.missing;'));
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/TypeError: cannot read property 'missing' of null \[line 3\]/);
  });

  it('reports syntax errors and missing returns', async () => {
    expect((await run(code('return [1,,'))).error?.message).toMatch(/SyntaxError/);
    expect((await run(code('const x = 1;'))).error?.message).toBe('The code did not return anything');
    expect((await run(code('return [1, 2];'))).error?.message).toBe('Item 0 is not an object (got number)');
  });

  it('has no access to the host: require, process, fetch do not exist', async () => {
    for (const snippet of ['require("fs")', 'process.exit(1)', 'fetch("http://example.com")']) {
      const r = await run(code(`${snippet};\nreturn [];`));
      expect(r.status).toBe('error');
      expect(r.error?.message).toMatch(/ReferenceError: '?(require|process|fetch)'? is not defined/);
      expect(r.error?.hint).toMatch(/not available in the Code node/);
    }
  });

  it('stops endless loops and memory bombs without crashing the server', async () => {
    const saved = { ...codeLimits };
    codeLimits.timeoutMs = 300;
    codeLimits.memoryLimitBytes = 16 * 1024 * 1024;
    try {
      const loop = await run(code('while (true) {}'));
      expect(loop.error?.message).toBe('Code took longer than 0.3 s and was stopped');
      const bomb = await run(code('const a = []; while (true) a.push("x".repeat(100000));'));
      expect(bomb.error?.message).toMatch(/more than 16 MB of memory|took longer/);
      // The sandbox still works afterwards.
      expect(out(await run(code('return [{ json: { ok: true } }];')), 'Node')).toEqual([{ ok: true }]);
    } finally {
      Object.assign(codeLimits, saved);
    }
  });

  it('stops running code when the execution is canceled', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const r = await run(code('while (true) {}'), { signal: controller.signal });
    expect(r.status).toBe('canceled');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('binary store', () => {
  const store = new BinaryStore(mkdtempSync(join(tmpdir(), 'ff-bin-test-')));

  it('stores, reads and deletes files per execution', async () => {
    const ref = await store.store('77', Buffer.from('hello'), 'hello.txt');
    expect(ref).toMatchObject({ mimeType: 'text/plain', fileName: 'hello.txt', fileExtension: 'txt', fileSize: 5 });
    expect(ref.id).toMatch(/^77\/[\w-]+$/);
    expect((await store.read(ref)).toString()).toBe('hello');
    await store.deleteExecution('77');
    await expect(store.read(ref)).rejects.toThrow(/no longer exists/);
  });

  it('refuses path traversal in ids', async () => {
    await expect(store.read({ id: '../../etc/passwd' })).rejects.toThrow(/Invalid binary data id/);
    await expect(store.read({ id: '77/../../x' })).rejects.toThrow(/Invalid binary data id/);
  });

  it('nodes can create binary data and read it back', async () => {
    const r = await run(wf([['T', 'manual'], ['Make', 'test.makeFile'], ['Pass', 'noop'], ['Read', 'test.readFile']], [['T', 'Make'], ['Make', 'Pass'], ['Pass', 'Read']]));
    expect(r.status).toBe('success');
    expect(r.runData.Pass![0]!.data.main[0]![0]!.binary?.data).toMatchObject({ mimeType: 'text/csv', fileName: 'table.csv' });
    expect(out(r, 'Read')).toEqual([{ text: 'a,b\n1,2' }]);
  });
});

describe('Code node per-item errors', () => {
  const each = (extra: Record<string, unknown>) =>
    wf(
      [
        ['T', 'manual'],
        ['Data', 'test.emit', emit([{ id: 1 }, { id: 2, bad: true }, { id: 3 }])],
        ['Code', 'code', { mode: 'runOnceForEachItem', jsCodeEachItem: "if ($json.bad) throw new Error('bad item ' + $json.id);\nreturn { ...$json, ok: true };" }, extra],
      ],
      [['T', 'Data'], ['Data', 'Code']],
    );

  it('stop (default): fails with the item index and line', async () => {
    const r = await run(each({}));
    expect(r.status).toBe('error');
    expect(r.error).toMatchObject({ message: 'bad item 2 [line 1]', itemIndex: 1 });
  });

  it('continue with error output: only the failing item is routed', async () => {
    const r = await run(each({ onError: 'continueErrorOutput' }));
    expect(out(r, 'Code', 0).map((j) => j.id)).toEqual([1, 3]);
    expect(out(r, 'Code', 1)).toEqual([{ id: 2, bad: true, error: 'bad item 2 [line 1]' }]);
  });

  it('continue (regular output): the failing item becomes an error item', async () => {
    const r = await run(each({ onError: 'continueRegularOutput' }));
    expect(out(r, 'Code')).toEqual([{ id: 1, ok: true }, { error: 'bad item 2 [line 1]' }, { id: 3, ok: true }]);
  });
});
