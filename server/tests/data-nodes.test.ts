import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Item, JsonObject, WorkflowNode } from '@flowforge/shared';
import { parseDate } from '../src/nodes/transform/date-time.node.js';
import { emit, getTestRegistry, out, run, wf } from './engine-helpers.js';

/** Trigger → Data → node under test ("Node"). */
const flow = (type: string, params: JsonObject, data: JsonObject[], extra: Partial<WorkflowNode> = {}) =>
  wf([['T', 'manual'], ['Data', 'test.emit', emit(data)], ['Node', `flowforge.${type}`, params, extra]], [['T', 'Data'], ['Data', 'Node']]);

const exec = async (type: string, params: JsonObject, data: JsonObject[], extra: Partial<WorkflowNode> = {}, req = {}) => run(flow(type, params, data, extra), req);
const result = async (type: string, params: JsonObject, data: JsonObject[], extra: Partial<WorkflowNode> = {}) => out(await exec(type, params, data, extra), 'Node');
const itemsOf = (r: Awaited<ReturnType<typeof run>>, output = 0): Item[] => r.runData.Node?.[0]?.data.main[output] ?? [];

const people = [
  { id: 1, name: 'Ada', city: 'London', age: 36, tags: ['math', 'code'], address: { city: 'London', zip: 'N1' } },
  { id: 2, name: 'Alan', city: 'London', age: 41, tags: ['code'], address: { city: 'London', zip: 'W2' } },
  { id: 3, name: 'Grace', city: 'New York', age: 85, tags: [], address: { city: 'New York' } },
];

describe('registry', () => {
  it('auto-loads the Phase 4 nodes', async () => {
    const types = (await getTestRegistry()).list().map((n) => n.type);
    for (const type of ['aggregate', 'splitOut', 'removeDuplicates', 'summarize', 'compareDatasets', 'dateTime', 'crypto', 'html', 'xml', 'markdown', 'convertToFile', 'extractFromFile', 'readWriteFile', 'executeCommand', 'httpRequest', 'graphql']) {
      expect(types, type).toContain(`flowforge.${type}`);
    }
  });
});

describe('Aggregate', () => {
  const fields = (...list: Array<string | { fieldToAggregate: string; renameField?: boolean; outputFieldName?: string }>) => ({
    fieldsToAggregate: { fieldToAggregate: list.map((f) => (typeof f === 'string' ? { fieldToAggregate: f } : f)) },
  });

  it('collects fields of all items into lists in one item', async () => {
    const r = await exec('aggregate', fields('name', { fieldToAggregate: 'age', renameField: true, outputFieldName: 'ages' }, 'address.zip'), people);
    expect(out(r, 'Node')).toEqual([{ name: ['Ada', 'Alan', 'Grace'], ages: [36, 41, 85], zip: ['N1', 'W2'] }]);
    // The single item comes from every input item.
    expect(itemsOf(r)[0]!.pairedItem).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);
  });

  it('options: keep missing values, merge lists, no dot notation', async () => {
    expect(await result('aggregate', { ...fields('address.zip'), options: { keepMissing: true } }, people)).toEqual([{ zip: ['N1', 'W2', null] }]);
    expect(await result('aggregate', { ...fields('tags'), options: { mergeLists: true } }, people)).toEqual([{ tags: ['math', 'code', 'code'] }]);
    expect(await result('aggregate', fields('tags'), people)).toEqual([{ tags: [['math', 'code'], ['code'], []] }]);
    expect(await result('aggregate', { ...fields('a.b'), options: { disableDotNotation: true } }, [{ 'a.b': 1 }, { a: { b: 2 } }])).toEqual([{ 'a.b': [1] }]);
  });

  it('all item data into a single list: all fields, some, or all except', async () => {
    const small = people.map(({ id, name, age }) => ({ id, name, age }));
    expect(await result('aggregate', { aggregate: 'aggregateAllItemData' }, small)).toEqual([{ data: small }]);
    expect(await result('aggregate', { aggregate: 'aggregateAllItemData', destinationFieldName: 'people', include: 'specifiedFields', fieldsToInclude: 'name, age' }, small)).toEqual([
      { people: [{ name: 'Ada', age: 36 }, { name: 'Alan', age: 41 }, { name: 'Grace', age: 85 }] },
    ]);
    expect(await result('aggregate', { aggregate: 'aggregateAllItemData', include: 'allFieldsExcept', fieldsToExclude: 'id,age' }, small)).toEqual([{ data: [{ name: 'Ada' }, { name: 'Alan' }, { name: 'Grace' }] }]);
  });

  it('edge cases: items without the field, no field configured, two fields with the same name', async () => {
    expect(await result('aggregate', fields('email'), [{}, { other: 1 }])).toEqual([{ email: [] }]);
    expect((await exec('aggregate', {}, people)).error?.message).toBe('Add at least one field to aggregate');
    expect((await exec('aggregate', fields('address.city', 'city'), people)).error).toMatchObject({ message: 'Two fields would be written to "city"', hint: 'Rename one of them with "Rename Field".' });
    expect((await exec('aggregate', { aggregate: 'aggregateAllItemData', include: 'specifiedFields' }, people)).error?.message).toBe('No fields to include');
  });
});

describe('Split Out', () => {
  it('turns a list into one item per element', async () => {
    const r = await exec('splitOut', { fieldToSplitOut: 'tags' }, people);
    expect(out(r, 'Node')).toEqual([{ tags: 'math' }, { tags: 'code' }, { tags: 'code' }]);
    expect(itemsOf(r).map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 0 }, { item: 1 }]);
  });

  it('a list of objects becomes the items themselves; other fields can be kept', async () => {
    const orders = [{ order: 7, customer: { name: 'Ada' }, lines: [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }] }];
    expect(await result('splitOut', { fieldToSplitOut: 'lines' }, orders)).toEqual([{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }]);
    expect(await result('splitOut', { fieldToSplitOut: 'lines', include: 'allOtherFields' }, orders)).toEqual([
      { order: 7, customer: { name: 'Ada' }, lines: { sku: 'A', qty: 1 } },
      { order: 7, customer: { name: 'Ada' }, lines: { sku: 'B', qty: 2 } },
    ]);
    expect(await result('splitOut', { fieldToSplitOut: 'lines', include: 'selectedOtherFields', fieldsToInclude: 'customer.name', options: { destinationFieldName: 'line' } }, orders)).toEqual([
      { customer: { name: 'Ada' }, line: { sku: 'A', qty: 1 } },
      { customer: { name: 'Ada' }, line: { sku: 'B', qty: 2 } },
    ]);
  });

  it('several fields are split side by side; nested fields, single values and objects work too', async () => {
    expect(await result('splitOut', { fieldToSplitOut: 'names, ages' }, [{ names: ['Ada', 'Alan'], ages: [36, 41, 99] }])).toEqual([{ names: 'Ada', ages: 36 }, { names: 'Alan', ages: 41 }, { ages: 99 }]);
    expect(await result('splitOut', { fieldToSplitOut: 'data.list' }, [{ data: { list: [1, 2] } }])).toEqual([{ list: 1 }, { list: 2 }]);
    expect(await result('splitOut', { fieldToSplitOut: 'name' }, [{ name: 'Ada' }])).toEqual([{ name: 'Ada' }]);
    expect(await result('splitOut', { fieldToSplitOut: 'scores' }, [{ scores: { math: 9, art: 7 } }])).toEqual([{ scores: 9 }, { scores: 7 }]);
    // An empty list gives no item.
    expect(await result('splitOut', { fieldToSplitOut: 'tags' }, [{ tags: [] }, { tags: ['x'] }])).toEqual([{ tags: 'x' }]);
  });

  it('a missing field is a clear error; "On Error" decides per item', async () => {
    const data = [{ tags: ['a'] }, { other: 1 }, { tags: ['b'] }];
    const stop = await exec('splitOut', { fieldToSplitOut: 'tags' }, data);
    expect(stop.status).toBe('error');
    expect(stop.error).toMatchObject({ message: 'Field "tags" was not found in item 1', itemIndex: 1, hint: 'Fields of this item: other. Check the name (it is case-sensitive).' });
    expect(await result('splitOut', { fieldToSplitOut: 'tags' }, data, { onError: 'continueRegularOutput' })).toEqual([{ tags: 'a' }, { error: 'Field "tags" was not found in item 1' }, { tags: 'b' }]);
    const routed = await exec('splitOut', { fieldToSplitOut: 'tags' }, data, { onError: 'continueErrorOutput' });
    expect(out(routed, 'Node', 0)).toEqual([{ tags: 'a' }, { tags: 'b' }]);
    expect(out(routed, 'Node', 1)).toEqual([{ other: 1, error: 'Field "tags" was not found in item 1' }]);
    expect((await exec('splitOut', { fieldToSplitOut: ' ' }, data)).error?.message).toBe('"Fields To Split Out" is empty');
  });
});

describe('Remove Duplicates', () => {
  const rows = [
    { id: 1, email: 'ada@x.com', name: 'Ada' },
    { id: 2, email: 'ADA@x.com', name: 'Ada' },
    { id: 3, email: 'alan@x.com', name: 'Alan' },
    { id: 1, email: 'ada@x.com', name: 'Ada' },
  ];

  it('all fields: keeps the first of identical items, the rest goes to the second output', async () => {
    const r = await exec('removeDuplicates', {}, rows);
    expect(out(r, 'Node', 0).map((i) => i.id)).toEqual([1, 2, 3]);
    expect(out(r, 'Node', 1)).toEqual([rows[3]]);
    expect(itemsOf(r, 1)[0]!.pairedItem).toEqual({ item: 3 });
    // Key order does not matter.
    expect(await result('removeDuplicates', {}, [{ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }])).toHaveLength(1);
  });

  it('selected fields, all fields except, ignore case, remove other fields', async () => {
    expect((await result('removeDuplicates', { compare: 'selectedFields', fieldsToCompare: 'name' }, rows)).map((i) => i.id)).toEqual([1, 3]);
    expect((await result('removeDuplicates', { compare: 'selectedFields', fieldsToCompare: 'email' }, rows)).map((i) => i.id)).toEqual([1, 2, 3]);
    expect((await result('removeDuplicates', { compare: 'selectedFields', fieldsToCompare: 'email', options: { ignoreCase: true } }, rows)).map((i) => i.id)).toEqual([1, 3]);
    expect((await result('removeDuplicates', { compare: 'allFieldsExcept', fieldsToExclude: 'id, email' }, rows)).map((i) => i.id)).toEqual([1, 3]);
    expect(await result('removeDuplicates', { compare: 'selectedFields', fieldsToCompare: 'name', options: { removeOtherFields: true } }, rows)).toEqual([{ name: 'Ada' }, { name: 'Alan' }]);
  });

  it('edge cases: nothing to compare, a field that no item has, items without the field', async () => {
    expect((await exec('removeDuplicates', { compare: 'selectedFields' }, rows)).error?.message).toBe('No fields to compare');
    expect((await exec('removeDuplicates', { compare: 'selectedFields', fieldsToCompare: 'Email' }, rows)).error).toMatchObject({
      message: 'No input item has the field "Email"',
      hint: 'Fields of the first item: id, email, name. Check the name (it is case-sensitive).',
    });
    // Items without the field are duplicates of each other.
    expect(await result('removeDuplicates', { compare: 'selectedFields', fieldsToCompare: 'email' }, [{ email: 'a' }, {}, { name: 'x' }])).toEqual([{ email: 'a' }, {}]);
  });
});

describe('Summarize', () => {
  const orders = [
    { country: 'FR', city: 'Paris', product: 'pen', price: 2, qty: 10 },
    { country: 'FR', city: 'Lyon', product: 'ink', price: 5.5, qty: 1 },
    { country: 'US', city: 'NYC', product: 'pen', price: 3, qty: 4 },
    { country: 'FR', city: 'Paris', product: 'pen', price: '4', qty: null },
  ];
  const summaries = (...list: Array<[string, string, JsonObject?]>) => ({ fieldsToSummarize: { values: list.map(([aggregation, field, more]) => ({ aggregation, field, ...more })) } });

  it('every aggregation over all items', async () => {
    const params = summaries(['sum', 'price'], ['average', 'price'], ['min', 'price'], ['max', 'price'], ['count', 'qty'], ['countUnique', 'product'], ['append', 'city'], ['concatenate', 'product', { separateBy: ' | ' }]);
    expect(await result('summarize', params, orders)).toEqual([
      { sum_price: 14.5, average_price: 3.625, min_price: 2, max_price: 5.5, count_qty: 3, unique_count_product: 2, appended_city: ['Paris', 'Lyon', 'NYC', 'Paris'], concatenated_product: 'pen | ink | pen | pen' },
    ]);
  });

  it('split by one or several fields (group by), as separate items or one item', async () => {
    const r = await exec('summarize', { ...summaries(['sum', 'price'], ['count', 'product']), fieldsToSplitBy: 'country' }, orders);
    expect(out(r, 'Node')).toEqual([
      { country: 'FR', sum_price: 11.5, count_product: 3 },
      { country: 'US', sum_price: 3, count_product: 1 },
    ]);
    expect(itemsOf(r)[0]!.pairedItem).toEqual([{ item: 0 }, { item: 1 }, { item: 3 }]);
    expect(await result('summarize', { ...summaries(['count', 'product']), fieldsToSplitBy: 'country, city' }, orders)).toEqual([
      { country: 'FR', city: 'Paris', count_product: 2 },
      { country: 'FR', city: 'Lyon', count_product: 1 },
      { country: 'US', city: 'NYC', count_product: 1 },
    ]);
    expect(await result('summarize', { ...summaries(['sum', 'qty']), fieldsToSplitBy: 'country, city', options: { outputFormat: 'singleItem' } }, orders)).toEqual([
      { FR: { Paris: { sum_qty: 10 }, Lyon: { sum_qty: 1 } }, US: { NYC: { sum_qty: 4 } } },
    ]);
    expect(await result('summarize', { ...summaries(['sum', 'qty']), options: { outputFormat: 'singleItem' } }, orders)).toEqual([{ sum_qty: 15 }]);
  });

  it('empty values: skipped by default, included on request; items without a group', async () => {
    const data = [{ g: 'a', v: 1 }, { g: 'a', v: '' }, { g: null, v: 5 }, { v: 7 }];
    expect(await result('summarize', summaries(['count', 'v'], ['append', 'v']), data)).toEqual([{ count_v: 3, appended_v: [1, 5, 7] }]);
    expect(await result('summarize', summaries(['count', 'v', { includeEmpty: true }], ['append', 'v', { includeEmpty: true }]), data)).toEqual([{ count_v: 4, appended_v: [1, '', 5, 7] }]);
    expect(await result('summarize', { ...summaries(['sum', 'v']), fieldsToSplitBy: 'g' }, data)).toEqual([{ g: 'a', sum_v: 1 }, { g: null, sum_v: 12 }]);
    expect(await result('summarize', { ...summaries(['sum', 'v']), fieldsToSplitBy: 'g', options: { skipEmptySplitFields: true } }, data)).toEqual([{ g: 'a', sum_v: 1 }]);
    // Nested fields: dots become underscores in the output name.
    expect(await result('summarize', summaries(['max', 'stats.score']), [{ stats: { score: 3 } }, { stats: { score: 9 } }])).toEqual([{ max_stats_score: 9 }]);
  });

  it('bad input: text in a numeric aggregation, unknown field, nothing configured', async () => {
    expect((await exec('summarize', summaries(['sum', 'city']), orders)).error).toMatchObject({
      message: 'Field "city" has a value that is not a number: "Paris"',
      hint: '"sum" needs numbers. Use Count, Append or Concatenate for text.',
    });
    expect((await exec('summarize', summaries(['sum', 'Price']), orders)).error?.message).toBe('The field "Price" does not exist in any item');
    expect(await result('summarize', { ...summaries(['sum', 'Price'], ['count', 'Price']), options: { continueIfFieldNotFound: true } }, orders)).toEqual([{ sum_Price: 0, count_Price: 0 }]);
    expect((await exec('summarize', {}, orders)).error?.message).toBe('Add at least one field to summarize');
    expect((await exec('summarize', { ...summaries(['count', 'price']), fieldsToSplitBy: 'nope' }, orders)).error?.message).toBe('The field "nope" does not exist in any item');
  });

  it('a node that works on all items at once follows "On Error" as a whole', async () => {
    const bad = summaries(['sum', 'city']);
    expect(await result('summarize', bad, orders, { onError: 'continueRegularOutput' })).toEqual([{ error: 'Field "city" has a value that is not a number: "Paris"' }]);
    const routed = await exec('summarize', bad, orders, { onError: 'continueErrorOutput' });
    expect(routed.status).toBe('success');
    expect(out(routed, 'Node', 0)).toEqual([]);
    expect(out(routed, 'Node', 1)).toHaveLength(4);
    expect(out(routed, 'Node', 1)[0]).toMatchObject({ country: 'FR', error: 'Field "city" has a value that is not a number: "Paris"' });
    expect(await result('aggregate', {}, orders, { onError: 'continueRegularOutput' })).toEqual([{ error: 'Add at least one field to aggregate' }]);
    expect(await result('removeDuplicates', { compare: 'selectedFields', fieldsToCompare: 'nope' }, orders, { onError: 'continueRegularOutput' })).toEqual([{ error: 'No input item has the field "nope"' }]);
  });
});

describe('Compare Datasets', () => {
  const a = [
    { id: 1, name: 'Ada', email: 'ada@a.com', plan: 'pro' },
    { id: 2, name: 'Alan', email: 'alan@a.com', plan: 'free' },
    { id: 3, name: 'Grace', email: 'grace@a.com', plan: 'free' },
  ];
  const b = [
    { id: 2, name: 'Alan', email: 'alan@b.com', plan: 'pro' },
    { id: 3, name: 'Grace', email: 'grace@a.com', plan: 'free' },
    { id: 4, name: 'Linus', email: 'linus@b.com', plan: 'free' },
  ];
  const compare = (params: JsonObject, left: JsonObject[] = a, right: JsonObject[] = b, extra: Partial<WorkflowNode> = {}) =>
    run(
      wf(
        [['T', 'manual'], ['A', 'test.emit', emit(left)], ['B', 'test.emit', emit(right)], ['Node', 'flowforge.compareDatasets', { mergeByFields: { values: [{ field1: 'id', field2: 'id' }] }, ...params }, extra]],
        [['T', 'A'], ['T', 'B'], ['A', 'Node', 0, 0], ['B', 'Node', 0, 1]],
      ),
    );

  it('four outputs: only in A, same, different (both versions), only in B', async () => {
    const r = await compare({});
    expect(out(r, 'Node', 0)).toEqual([a[0]]);
    expect(out(r, 'Node', 1)).toEqual([a[2]]);
    expect(out(r, 'Node', 2)).toEqual([
      { keys: { id: 2 }, same: { name: 'Alan' }, different: { email: { inputA: 'alan@a.com', inputB: 'alan@b.com' }, plan: { inputA: 'free', inputB: 'pro' } } },
    ]);
    expect(out(r, 'Node', 3)).toEqual([b[2]]);
    expect(itemsOf(r, 2)[0]!.pairedItem).toEqual([{ item: 1, input: 0 }, { item: 0, input: 1 }]);
  });

  it('differences can be resolved: use A, use B, or a mix', async () => {
    expect(out(await compare({ resolve: 'preferInput1' }), 'Node', 2)).toEqual([a[1]]);
    expect(out(await compare({ resolve: 'preferInput2' }), 'Node', 2)).toEqual([b[0]]);
    expect(out(await compare({ resolve: 'mix', preferWhenMix: 'input1', exceptWhenMix: 'plan' }), 'Node', 2)).toEqual([{ id: 2, name: 'Alan', email: 'alan@a.com', plan: 'pro' }]);
    expect(out(await compare({ resolve: 'mix', preferWhenMix: 'input2', exceptWhenMix: 'email' }), 'Node', 2)).toEqual([{ id: 2, name: 'Alan', email: 'alan@a.com', plan: 'pro' }]);
  });

  it('options: skip fields, fuzzy compare, different key names, all matches', async () => {
    expect(out(await compare({ options: { skipFields: 'email, plan' } }), 'Node', 1).map((i) => i.id)).toEqual([2, 3]);
    const typed = await compare({}, [{ id: 1, n: 3 }], [{ id: '1', n: '3' }]);
    expect(out(typed, 'Node', 0)).toHaveLength(1); // 1 and "1" are different keys…
    const fuzzy = await compare({ options: { fuzzyCompare: true } }, [{ id: 1, n: 3 }], [{ id: '1', n: '3' }]);
    expect(out(fuzzy, 'Node', 1)).toEqual([{ id: 1, n: 3 }]); // …unless fuzzy compare is on
    const renamed = await compare({ mergeByFields: { values: [{ field1: 'id', field2: 'userId' }] } }, [{ id: 1, v: 'x' }], [{ userId: 1, v: 'x' }, { userId: 9, v: 'y' }]);
    expect(out(renamed, 'Node', 1)).toEqual([{ id: 1, v: 'x' }]);
    expect(out(renamed, 'Node', 3)).toEqual([{ userId: 9, v: 'y' }]);
    const dup = [{ id: 1, v: 'x' }, { id: 1, v: 'z' }];
    expect(out(await compare({ resolve: 'preferInput2' }, [{ id: 1, v: 'x' }], dup), 'Node', 2)).toEqual([]);
    const all = await compare({ resolve: 'preferInput2', options: { multipleMatches: 'all' } }, [{ id: 1, v: 'x' }], dup);
    expect(out(all, 'Node', 1)).toHaveLength(1);
    expect(out(all, 'Node', 2)).toEqual([{ id: 1, v: 'z' }]);
    expect(out(all, 'Node', 3)).toEqual([]);
  });

  it('edge cases: an empty input, items without the key, wrong field name, nothing to match', async () => {
    const onlyA = await compare({}, a, []);
    expect(onlyA.status).toBe('success');
    expect(out(onlyA, 'Node', 0)).toEqual(a);
    const missing = await compare({}, [{ id: 1 }, { name: 'no id' }], [{ id: 1 }, { name: 'no id' }]);
    expect(out(missing, 'Node', 0)).toEqual([{ name: 'no id' }]);
    expect(out(missing, 'Node', 1)).toEqual([{ id: 1 }]);
    expect(out(missing, 'Node', 3)).toEqual([{ name: 'no id' }]);
    expect((await compare({ mergeByFields: { values: [{ field1: 'ID', field2: 'id' }] } })).error).toMatchObject({ message: 'No item of Input A has the field "ID"' });
    expect((await compare({ mergeByFields: { values: [{ field1: '', field2: '' }] } })).error?.message).toBe('Add at least one field to match');
  });
});

describe('Date & Time', () => {
  const paris = { timezone: 'Europe/Paris' };
  const one = async (params: JsonObject, data: JsonObject = { d: '2026-03-14T09:30:00' }, extra: Partial<WorkflowNode> = {}, req: JsonObject = paris) =>
    out(await exec('dateTime', { options: { includeInputFields: false }, ...params }, [data], extra, req), 'Node')[0];

  it('add and subtract time', async () => {
    expect(await one({ operation: 'addToDate', magnitude: '={{ $json.d }}', timeUnit: 'days', duration: 20 })).toEqual({ newDate: '2026-04-03T09:30:00.000+02:00' });
    expect(await one({ operation: 'addToDate', magnitude: '={{ $json.d }}', timeUnit: 'months', duration: 1, outputFieldName: 'due' })).toEqual({ due: '2026-04-14T09:30:00.000+02:00' });
    expect(await one({ operation: 'subtractFromDate', magnitude: '2026-03-01', timeUnit: 'hours', duration: 36 })).toEqual({ newDate: '2026-02-27T12:00:00.000+01:00' });
    // The end of January plus one month stays in February.
    expect(await one({ operation: 'addToDate', magnitude: '2026-01-31', timeUnit: 'months', duration: 1 })).toEqual({ newDate: '2026-02-28T00:00:00.000+01:00' });
  });

  it('format: presets, custom Luxon format, timestamps, another time zone', async () => {
    expect(await one({ operation: 'formatDate', date: '={{ $json.d }}', format: 'dd/MM/yyyy' })).toEqual({ formattedDate: '14/03/2026' });
    expect(await one({ operation: 'formatDate', date: '={{ $json.d }}', format: 'custom', customFormat: "cccc d LLLL yyyy 'at' HH:mm" })).toEqual({ formattedDate: 'Saturday 14 March 2026 at 09:30' });
    expect(await one({ operation: 'formatDate', date: '={{ $json.d }}', format: 'X' })).toEqual({ formattedDate: 1773477000 });
    expect(await one({ operation: 'formatDate', date: '2026-03-14T09:30:00Z', format: 'custom', customFormat: 'HH:mm ZZZZ', options: { includeInputFields: false, timezone: 'America/New_York' } })).toEqual({ formattedDate: '05:30 EDT' });
    // Input fields are kept by default.
    expect(out(await exec('dateTime', { operation: 'formatDate', date: '={{ $json.d }}', format: 'yyyy-MM-dd' }, [{ d: '2026-03-14', keep: 1 }]), 'Node')[0]).toEqual({ d: '2026-03-14', keep: 1, formattedDate: '2026-03-14' });
  });

  it('time between dates, in the chosen units or as an ISO duration', async () => {
    const base = { operation: 'getTimeBetweenDates', startDate: '2026-01-01', endDate: '2026-03-14T12:00:00' };
    expect(await one({ ...base })).toEqual({ timeDifference: { days: 72.5 } });
    expect(await one({ ...base, units: ['months', 'days', 'hours'] })).toEqual({ timeDifference: { months: 2, days: 13, hours: 12 } });
    expect(await one({ ...base, units: ['weeks'], differenceFieldName: 'age' })).toEqual({ age: { weeks: 10.357 } });
    expect(await one({ ...base, units: ['days', 'hours'], options: { includeInputFields: false, isoString: true } })).toEqual({ timeDifference: 'P72DT12H' });
    // A negative difference when the end is before the start.
    expect(await one({ operation: 'getTimeBetweenDates', startDate: '2026-03-14', endDate: '2026-03-10' })).toEqual({ timeDifference: { days: -4 } });
  });

  it('round, extract a part, convert to a time zone, current date', async () => {
    expect(await one({ operation: 'roundDate', date: '={{ $json.d }}', toNearest: 'month' })).toEqual({ roundedDate: '2026-03-01T00:00:00.000+01:00' });
    expect(await one({ operation: 'roundDate', date: '={{ $json.d }}', mode: 'roundUp', toNearest: 'hour' })).toEqual({ roundedDate: '2026-03-14T10:00:00.000+01:00' });
    expect(await one({ operation: 'roundDate', date: '2026-03-14T10:00:00', mode: 'roundUp', toNearest: 'hour' })).toEqual({ roundedDate: '2026-03-14T10:00:00.000+01:00' });
    expect(await one({ operation: 'extractDate', date: '={{ $json.d }}', part: 'week' })).toEqual({ datePart: 11 });
    expect(await one({ operation: 'extractDate', date: '={{ $json.d }}', part: 'weekday' })).toEqual({ datePart: 6 });
    expect(await one({ operation: 'extractDate', date: '={{ $json.d }}', part: 'quarter', partFieldName: 'q' })).toEqual({ q: 1 });
    expect(await one({ operation: 'setTimezone', date: '={{ $json.d }}', timezone: 'Asia/Tokyo' })).toEqual({ convertedDate: '2026-03-14T17:30:00.000+09:00' });
    const now = (await one({ operation: 'getCurrentDate' })) as { currentDate: string };
    expect(Math.abs(Date.parse(now.currentDate) - Date.now())).toBeLessThan(5000);
    const today = (await one({ operation: 'getCurrentDate', includeTime: false })) as { currentDate: string };
    expect(today.currentDate).toMatch(/T00:00:00\.000[+-]\d\d:\d\d$/);
  });

  it('reads many date shapes', () => {
    const iso = (v: unknown, fmt?: string) => parseDate(v, 'UTC', fmt).toUTC().toISO();
    expect(iso('2026-03-14')).toBe('2026-03-14T00:00:00.000Z');
    expect(iso('2026-03-14T09:30:00+02:00')).toBe('2026-03-14T07:30:00.000Z');
    expect(iso('2026-03-14 09:30:00')).toBe('2026-03-14T09:30:00.000Z');
    expect(iso('Sat, 14 Mar 2026 09:30:00 GMT')).toBe('2026-03-14T09:30:00.000Z');
    expect(iso(1773480600)).toBe('2026-03-14T09:30:00.000Z');
    expect(iso('1773480600000')).toBe('2026-03-14T09:30:00.000Z');
    expect(iso('March 14, 2026')).toBe('2026-03-14T00:00:00.000Z');
    expect(iso('14/03/2026 09:30', 'dd/MM/yyyy HH:mm')).toBe('2026-03-14T09:30:00.000Z');
    for (const bad of ['not a date', '', null, undefined, {}, '2026-13-45']) expect(() => parseDate(bad, 'UTC'), String(bad)).toThrow(/is not a date FlowForge can read/);
  });

  it('bad input: unreadable dates per item (On Error), wrong format, unknown time zone', async () => {
    const data = [{ d: '2026-03-14' }, { d: 'tomorrow-ish' }, { d: null }];
    const params = { operation: 'formatDate', date: '={{ $json.d }}', format: 'yyyy/MM/dd', options: { includeInputFields: false } };
    const stop = await exec('dateTime', params, data);
    expect(stop.error).toMatchObject({ message: '"tomorrow-ish" is not a date FlowForge can read', itemIndex: 1 });
    expect(stop.error?.hint).toMatch(/Use an ISO date such as 2026-03-14/);
    expect(await result('dateTime', params, data, { onError: 'continueRegularOutput' })).toEqual([
      { formattedDate: '2026/03/14' },
      { error: '"tomorrow-ish" is not a date FlowForge can read' },
      { error: 'null is not a date FlowForge can read' },
    ]);
    expect((await exec('dateTime', { ...params, options: { fromFormat: 'dd.MM.yyyy' } }, [{ d: '2026-03-14' }])).error?.hint).toBe('It does not match the format "dd.MM.yyyy".');
    expect((await exec('dateTime', { operation: 'setTimezone', date: '2026-03-14', timezone: 'Mars/Olympus' }, [{}])).error).toMatchObject({ message: '"Mars/Olympus" is not a time zone' });
    expect((await exec('dateTime', { ...params, format: 'custom', customFormat: ' ' }, [{ d: '2026-03-14' }])).error?.message).toBe('The custom format is empty');
  });
});

describe('Crypto', () => {
  const one = async (params: JsonObject, data: JsonObject = { text: 'hello' }) => out(await exec('crypto', params, [data]), 'Node')[0];

  it('hash: known values, HEX or BASE64, into the chosen field', async () => {
    expect(await one({ action: 'hash', type: 'MD5', value: '={{ $json.text }}' })).toEqual({ text: 'hello', data: '5d41402abc4b2a76b9719d911017c592' });
    expect(await one({ action: 'hash', type: 'SHA256', value: 'hello', dataPropertyName: 'meta.hash' })).toEqual({ text: 'hello', meta: { hash: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' } });
    expect(await one({ action: 'hash', type: 'SHA1', value: 'hello', encoding: 'base64' })).toMatchObject({ data: 'qvTGHdzF6KLavt4PO0gs2a6pQ00=' });
    expect(String(((await one({ action: 'hash', type: 'SHA512', value: '' })) as JsonObject).data)).toHaveLength(128);
  });

  it('HMAC: known signature', async () => {
    expect(await one({ action: 'hmac', type: 'SHA256', value: 'The quick brown fox jumps over the lazy dog', secret: 'key' })).toMatchObject({ data: 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8' });
    expect((await exec('crypto', { action: 'hmac', value: 'x', secret: '' }, [{}])).error).toMatchObject({ message: 'The HMAC secret is empty' });
    // Per item: an empty secret for one item does not stop the others.
    const mixed = await result('crypto', { action: 'hmac', value: 'x', secret: '={{ $json.secret }}' }, [{ secret: 'k' }, { secret: '' }], { onError: 'continueRegularOutput' });
    expect(mixed.map((j) => (j.error ? j.error : typeof j.data))).toEqual(['string', 'The HMAC secret is empty']);
  });

  it('generate: UUID, letters and digits, hex, base64 — different every time', async () => {
    const rows = await result('crypto', { action: 'generate', encodingType: 'uuid', dataPropertyName: 'id' }, [{ n: 1 }, { n: 2 }]);
    expect(rows[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
    expect(rows[0]!.n).toBe(1);
    expect(((await one({ action: 'generate', encodingType: 'ascii', stringLength: 40 })) as JsonObject).data).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(((await one({ action: 'generate', encodingType: 'hex', stringLength: 7 })) as JsonObject).data).toMatch(/^[0-9a-f]{7}$/);
    expect(String(((await one({ action: 'generate', encodingType: 'base64', stringLength: 12 })) as JsonObject).data)).toHaveLength(12);
    expect((await exec('crypto', { action: 'generate', encodingType: 'hex', stringLength: 0 }, [{}])).error?.message).toBe('Length must be between 1 and 4096');
  });

  it('hashes a file, and explains a missing file', async () => {
    const hashFile = (extra: Partial<WorkflowNode> = {}) =>
      run(wf([['T', 'manual'], ['File', 'test.makeFile'], ['Node', 'flowforge.crypto', { action: 'hash', type: 'MD5', binaryData: true }, extra]], [['T', 'File'], ['File', 'Node']]));
    // md5 of "a,b\n1,2"
    expect(out(await hashFile(), 'Node')[0]).toEqual({ name: 'table', data: createHash('md5').update('a,b\n1,2').digest('hex') });
    const missing = await exec('crypto', { action: 'hash', binaryData: true, binaryPropertyName: 'photo' }, [{ a: 1 }]);
    expect(missing.error).toMatchObject({ message: 'Item 0 has no binary property "photo"' });
  });
});

describe('HTML', () => {
  const page = `<html><body><h1 class="title"> Hello   <b>World</b> </h1>
    <ul id="links"><li><a href="/a" title="First">A</a></li><li><a href="/b">B</a></li></ul>
    <input name="q" value="search me"><p class="price">12,50 €</p></body></html>`;
  const extract = (values: JsonObject[], more: JsonObject = {}, data: JsonObject[] = [{ data: page }], extra: Partial<WorkflowNode> = {}) =>
    exec('html', { operation: 'extractHtmlContent', extractionValues: { values }, ...more }, data, extra);

  it('extracts text, HTML, attributes and values with CSS selectors', async () => {
    const r = await extract([
      { key: 'title', cssSelector: 'h1.title' },
      { key: 'titleHtml', cssSelector: 'h1', returnValue: 'html' },
      { key: 'firstLink', cssSelector: '#links a', returnValue: 'attribute', attribute: 'href' },
      { key: 'links', cssSelector: '#links a', returnValue: 'attribute', attribute: 'href', returnArray: true },
      { key: 'labels', cssSelector: 'li', returnArray: true },
      { key: 'query', cssSelector: 'input[name=q]', returnValue: 'value' },
      { key: 'price', cssSelector: '.price' },
      { key: 'missing', cssSelector: '.nope' },
      { key: 'missingList', cssSelector: '.nope', returnArray: true },
      { key: 'noTitle', cssSelector: '#links li:last-child a', returnValue: 'attribute', attribute: 'title' },
    ]);
    expect(out(r, 'Node')).toEqual([
      { title: 'Hello World', titleHtml: 'Hello   <b>World</b>', firstLink: '/a', links: ['/a', '/b'], labels: ['A', 'B'], query: 'search me', price: '12,50 €', missing: null, missingList: [], noTitle: null },
    ]);
  });

  it('options and other sources: no trimming, a nested field, a file', async () => {
    expect(out(await extract([{ key: 't', cssSelector: 'h1' }], { options: { trimValues: false, cleanUpText: false } }), 'Node')).toEqual([{ t: ' Hello   World ' }]);
    expect(out(await extract([{ key: 't', cssSelector: 'b' }], { dataPropertyName: 'res.body' }, [{ res: { body: page } }]), 'Node')).toEqual([{ t: 'World' }]);
    const fromFile = await run(
      wf(
        [['T', 'manual'], ['File', 'test.makeFile'], ['Node', 'flowforge.html', { operation: 'extractHtmlContent', sourceData: 'binary', extractionValues: { values: [{ key: 'all', cssSelector: 'body' }] } }]],
        [['T', 'File'], ['File', 'Node']],
      ),
    );
    expect(out(fromFile, 'Node')).toEqual([{ all: 'a,b\n1,2' }]);
  });

  it('bad input: missing field, invalid selector, incomplete extraction (per item with On Error)', async () => {
    expect((await extract([{ key: 't', cssSelector: 'h1' }], {}, [{ html: page }])).error).toMatchObject({ message: 'Item 0 has no field "data"', hint: '"Field With The HTML" must name a field that contains HTML text. Fields of this item: html.' });
    expect((await extract([{ key: 't', cssSelector: 'h1' }], {}, [{ data: { not: 'text' } }])).error?.message).toBe('Field "data" of item 0 is not text');
    expect((await extract([{ key: 't', cssSelector: 'a[href' }])).error).toMatchObject({ message: '"a[href" is not a valid CSS selector' });
    expect((await extract([{ key: '', cssSelector: 'h1' }])).error?.message).toBe('The extraction value with selector "h1" has no key');
    expect((await extract([{ key: 'x', cssSelector: 'a', returnValue: 'attribute' }])).error?.message).toBe('"x": enter the attribute to read (e.g. href)');
    expect((await extract([])).error?.message).toBe('Add at least one extraction value');
    const mixed = await extract([{ key: 't', cssSelector: 'b' }], {}, [{ data: page }, { nope: 1 }], { onError: 'continueRegularOutput' });
    expect(out(mixed, 'Node')).toEqual([{ t: 'World' }, { error: 'Item 1 has no field "data"' }]);
  });

  it('generates HTML from a template with expressions, for every item', async () => {
    const template = '<h1>{{ $json.name }}</h1><p>{{ $json.age >= 40 ? "senior" : "junior" }} · {{ $itemIndex }}</p>';
    expect(await result('html', { operation: 'generateHtmlTemplate', html: template }, people.slice(0, 2))).toEqual([{ html: '<h1>Ada</h1><p>junior · 0</p>' }, { html: '<h1>Alan</h1><p>senior · 1</p>' }]);
    expect(await result('html', { operation: 'generateHtmlTemplate', html: '<p>static</p>', options: { outputFieldName: 'page' } }, [{}])).toEqual([{ page: '<p>static</p>' }]);
    expect((await exec('html', { operation: 'generateHtmlTemplate', html: '<p>{{ $json.a.b.c }}</p>' }, [{}])).error?.message).toMatch(/Cannot read properties of undefined/);
  });

  it('converts all items to one HTML table (values are escaped)', async () => {
    const rows = [{ name: 'Ada <b>', age: 36 }, { name: 'Alan', city: 'London', tags: ['x'] }];
    const [item] = await result('html', { operation: 'convertToHtmlTable', options: { capitalize: true, caption: 'People' } }, rows);
    const table = String(item!.table);
    expect(table).toContain('<caption>People</caption>');
    expect(table.match(/<th[ >]/g)).toHaveLength(4);
    expect(table).toMatch(/<th[^>]*>Name<\/th>/);
    expect(table).toContain('Ada &lt;b&gt;');
    expect(table).toContain('[&quot;x&quot;]');
    expect(table.match(/<tr>/g)).toHaveLength(3);
    const plain = String((await result('html', { operation: 'convertToHtmlTable', options: { customStyling: true } }, rows))[0]!.table);
    expect(plain).not.toContain('style=');
  });
});

describe('XML', () => {
  const xml = `<?xml version="1.0"?><order id="7" paid="true"><customer>Ada</customer><line sku="A">2</line><line sku="B">1</line><note> hi </note></order>`;

  it('XML to JSON: attributes merged, repeated tags as lists', async () => {
    expect(await result('xml', { mode: 'xmlToJson' }, [{ data: xml }])).toEqual([
      { order: { id: '7', paid: 'true', customer: 'Ada', line: [{ _: '2', sku: 'A' }, { _: '1', sku: 'B' }], note: 'hi' } },
    ]);
  });

  it('XML to JSON options', async () => {
    const parse = async (options: JsonObject, text = xml) => (await result('xml', { mode: 'xmlToJson', options }, [{ data: text }]))[0];
    expect(await parse({ explicitRoot: false, ignoreAttrs: true })).toEqual({ customer: 'Ada', line: ['2', '1'], note: 'hi' });
    expect(await parse({ mergeAttrs: false })).toMatchObject({ order: { $: { id: '7', paid: 'true' }, customer: 'Ada' } });
    expect(await parse({ explicitArray: true, ignoreAttrs: true })).toEqual({ order: { customer: ['Ada'], line: ['2', '1'], note: ['hi'] } });
    expect(await parse({ trim: false, ignoreAttrs: true })).toMatchObject({ order: { note: ' hi ' } });
    expect(await parse({ normalizeTags: true }, '<Root><Name>x</Name></Root>')).toEqual({ root: { name: 'x' } });
  });

  it('JSON to XML, and back again', async () => {
    const [item] = await result('xml', { mode: 'jsonToXml' }, [{ order: { $: { id: '7' }, customer: 'Ada & Co', line: ['2', '1'] } }]);
    expect(item!.data).toBe(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<order id="7">\n  <customer>Ada &amp; Co</customer>\n  <line>2</line>\n  <line>1</line>\n</order>`);
    expect(await result('xml', { mode: 'jsonToXml', dataPropertyName: 'xml', options: { headless: true, pretty: false, rootName: 'person' } }, [{ name: 'Ada', age: 36 }])).toEqual([{ xml: '<person><name>Ada</name><age>36</age></person>' }]);
    const round = await run(
      wf(
        [['T', 'manual'], ['Data', 'test.emit', emit([{ shop: { item: [{ name: 'pen', price: '2' }, { name: 'ink', price: '5' }] } }])], ['ToXml', 'flowforge.xml', { mode: 'jsonToXml' }], ['Node', 'flowforge.xml', { mode: 'xmlToJson' }]],
        [['T', 'Data'], ['Data', 'ToXml'], ['ToXml', 'Node']],
      ),
    );
    expect(out(round, 'Node')).toEqual([{ shop: { item: [{ name: 'pen', price: '2' }, { name: 'ink', price: '5' }] } }]);
  });

  it('bad input: invalid XML, missing field, names that are not valid tags (per item with On Error)', async () => {
    expect((await exec('xml', { mode: 'xmlToJson' }, [{ data: '<a><b></a>' }])).error?.message).toMatch(/^The XML of item 0 is not valid: /);
    expect((await exec('xml', { mode: 'xmlToJson' }, [{ body: xml }])).error).toMatchObject({ message: 'Item 0 has no field "data"' });
    expect((await exec('xml', { mode: 'xmlToJson' }, [{ data: 42 }])).error?.message).toBe('Field "data" of item 0 does not contain XML text');
    expect((await exec('xml', { mode: 'jsonToXml' }, [{ '1 bad name': 'x' }])).error?.message).toMatch(/^Item 0 cannot be written as XML/);
    expect(await result('xml', { mode: 'xmlToJson' }, [{ data: '<a>1</a>' }, { data: '<a>' }], { onError: 'continueRegularOutput' })).toEqual([{ a: '1' }, { error: expect.stringMatching(/^The XML of item 1 is not valid/) }]);
  });
});

describe('Markdown', () => {
  it('Markdown to HTML', async () => {
    const md = '# Title\n\nSome **bold** and *italic* text with a [link](https://x.test).\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const [item] = await result('markdown', { mode: 'markdownToHtml', markdown: '={{ $json.md }}' }, [{ md }]);
    const html = String(item!.data);
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<p>Some <strong>bold</strong> and <em>italic</em> text with a <a href="https://x.test">link</a>.</p>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<table>');
    expect(item!.md).toBe(md); // input fields are kept
    expect(await result('markdown', { mode: 'markdownToHtml', markdown: 'a\nb', destinationKey: 'out.html', options: { breaks: true, includeInputFields: false } }, [{}])).toEqual([{ out: { html: '<p>a<br>b</p>' } }]);
  });

  it('HTML to Markdown', async () => {
    const html = '<h2>News</h2><p>Hello <b>world</b>, see <a href="https://x.test">this</a>.</p><ul><li>one</li><li>two</li></ul><pre><code>x = 1</code></pre>';
    const [item] = await result('markdown', { mode: 'htmlToMarkdown', html, options: { includeInputFields: false } }, [{}]);
    expect(item!.data).toBe('## News\n\nHello **world**, see [this](https://x.test).\n\n-   one\n-   two\n\n```\nx = 1\n```');
    expect((await result('markdown', { mode: 'htmlToMarkdown', html: '<ul><li>a</li></ul>', options: { bulletMarker: '*' } }, [{}]))[0]!.data).toBe('*   a');
  });

  it('edge cases: empty text, and a value that is not text', async () => {
    expect(await result('markdown', { mode: 'markdownToHtml', markdown: '' }, [{ a: 1 }])).toEqual([{ a: 1, data: '' }]);
    expect(await result('markdown', { mode: 'htmlToMarkdown', html: '={{ $json.missing }}' }, [{ a: 1 }])).toEqual([{ a: 1, data: '' }]);
    const bad = await exec('markdown', { mode: 'markdownToHtml', markdown: '={{ $json.obj }}' }, [{ obj: { a: 1 } }, { obj: 'ok' }], { onError: 'continueRegularOutput' });
    expect(out(bad, 'Node')).toEqual([{ error: 'The Markdown of item 0 is not text' }, { obj: 'ok', data: '<p>ok</p>' }]);
  });
});
