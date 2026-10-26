import { beforeEach, describe, expect, it } from 'vitest';
import { counters, emit, out, run, wf } from './engine-helpers.js';

const people = [
  { id: 1, name: 'Ada', age: 36 },
  { id: 2, name: 'Alan', age: 41 },
  { id: 3, name: 'Grace', age: 85 },
];

const ifAgeOver = (n: number) => ({
  conditions: {
    conditions: [{ leftValue: '={{ $json.age }}', rightValue: n, operator: { type: 'number', operation: 'gt' } }],
    combinator: 'and',
  },
});

beforeEach(() => counters.clear());

describe('starting a run', () => {
  it('runs a linear workflow from the Manual Trigger', async () => {
    const r = await run(
      wf(
        [
          ['Trigger', 'manual'],
          ['People', 'test.emit', emit(people)],
          ['Greet', 'set', { assignments: { assignments: [{ name: 'greeting', value: '=Hi {{ $json.name }}', type: 'string' }] }, includeOtherFields: true }],
        ],
        [['Trigger', 'People'], ['People', 'Greet']],
      ),
    );
    expect(r.status).toBe('success');
    expect(r.order).toEqual(['Trigger', 'People', 'Greet']);
    expect(out(r, 'Greet').map((j) => j.greeting)).toEqual(['Hi Ada', 'Hi Alan', 'Hi Grace']);
    expect(r.lastNodeExecuted).toBe('Greet');
  });

  it('explains when there is no trigger', async () => {
    const r = await run(wf([['Set', 'set']], []));
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('This workflow has no trigger node');
    expect(r.error?.hint).toMatch(/Manual Trigger/);
  });

  it('needs a start node when several triggers exist (except the Manual Trigger in manual mode)', async () => {
    const nodes: Parameters<typeof wf>[0] = [['Manual', 'manual'], ['Other', 'test.trigger'], ['A', 'noop']];
    const edges: Parameters<typeof wf>[1] = [['Manual', 'A'], ['Other', 'A']];
    expect((await run(wf(nodes, edges))).order).toEqual(['Manual', 'A']);
    const trig = await run(wf(nodes, edges), { mode: 'trigger' });
    expect(trig.error?.message).toBe('This workflow has several triggers');
    expect((await run(wf(nodes, edges), { mode: 'trigger', startNode: 'Other' })).order).toEqual(['Other', 'A']);
  });

  it('uses trigger items instead of executing the start node', async () => {
    const r = await run(wf([['Hook', 'test.trigger'], ['A', 'noop']], [['Hook', 'A']]), { triggerItems: [{ json: { body: 'x' } }] });
    expect(out(r, 'A')).toEqual([{ body: 'x' }]);
  });

  it('rejects invalid workflows with clear messages', async () => {
    expect((await run(wf([['T', 'manual'], ['X', 'flowforge.doesNotExist']], [['T', 'X']]))).error?.message).toBe(
      'Unknown node type "flowforge.doesNotExist"',
    );
    expect((await run(wf([['T', 'manual']], [['T', 'Ghost']]))).error?.message).toMatch(/connected to "Ghost", which doesn't exist/);
    expect((await run(wf([['T', 'manual'], ['T', 'noop']], []))).error?.message).toBe('Two nodes are named "T"');
    expect((await run(wf([['T', 'manual', {}, { disabled: true }]], []))).error?.message).toMatch(/is disabled/);
  });

  it('ignores sticky notes', async () => {
    const r = await run(wf([['Note', 'sticky'], ['T', 'manual'], ['A', 'noop']], [['T', 'A']]));
    expect(r.status).toBe('success');
    expect(r.runData.Note).toBeUndefined();
  });
});

describe('branching', () => {
  it('IF sends items to true/false and skips empty branches', async () => {
    const r = await run(
      wf(
        [['T', 'manual'], ['People', 'test.emit', emit(people)], ['If', 'if', ifAgeOver(50)], ['Old', 'noop'], ['Young', 'noop'], ['Nobody', 'noop']],
        [['T', 'People'], ['People', 'If'], ['If', 'Old', 0], ['If', 'Young', 1], ['Young', 'Nobody']],
      ),
    );
    expect(out(r, 'If', 0).map((j) => j.name)).toEqual(['Grace']);
    expect(out(r, 'If', 1).map((j) => j.name)).toEqual(['Ada', 'Alan']);
    expect(out(r, 'Old')).toHaveLength(1);
    expect(r.edges).toContain('If[0]->Old[0]:1');
    expect(r.edges).toContain('If[1]->Young[0]:2');
  });

  it('does not run nodes behind an empty output', async () => {
    const r = await run(
      wf([['T', 'manual'], ['People', 'test.emit', emit(people)], ['If', 'if', ifAgeOver(100)], ['Old', 'noop']], [['T', 'People'], ['People', 'If'], ['If', 'Old', 0]]),
    );
    expect(r.runData.Old).toBeUndefined();
  });

  it('runs branches top-to-bottom, finishing one branch before the next (n8n v1 order)', async () => {
    const r = await run(
      wf(
        [
          ['T', 'manual'],
          ['Lower', 'noop', {}, { position: [200, 300] }],
          ['Lower 2', 'noop', {}, { position: [400, 300] }],
          ['Upper', 'noop', {}, { position: [200, -100] }],
          ['Upper 2', 'noop', {}, { position: [400, -100] }],
        ],
        [['T', 'Lower'], ['T', 'Upper'], ['Lower', 'Lower 2'], ['Upper', 'Upper 2']],
      ),
    );
    expect(r.order).toEqual(['T', 'Upper', 'Upper 2', 'Lower', 'Lower 2']);
  });

  it('"Always Output Data" lets downstream nodes run with an empty item', async () => {
    const r = await run(
      wf(
        [['T', 'manual'], ['People', 'test.emit', emit(people)], ['Filter', 'filter', ifAgeOver(100), { alwaysOutputData: true }], ['After', 'noop']],
        [['T', 'People'], ['People', 'Filter'], ['Filter', 'After']],
      ),
    );
    expect(out(r, 'After')).toEqual([{}]);
  });
});

describe('merge (multiple inputs)', () => {
  const twoBranches = (mergeParams: Record<string, unknown>, left: unknown[], right: unknown[]) =>
    wf(
      [
        ['T', 'manual'],
        ['Left', 'test.emit', emit(left as never), { position: [200, 0] }],
        ['Right', 'test.emit', emit(right as never), { position: [200, 200] }],
        ['Merge', 'merge', mergeParams, { position: [400, 100] }],
      ],
      [['T', 'Left'], ['T', 'Right'], ['Left', 'Merge', 0, 0], ['Right', 'Merge', 0, 1]],
    );

  it('waits for both inputs, then appends input 1 + input 2', async () => {
    const r = await run(twoBranches({ mode: 'append' }, [{ a: 1 }], [{ b: 2 }, { b: 3 }]));
    expect(r.runData.Merge).toHaveLength(1);
    expect(out(r, 'Merge')).toEqual([{ a: 1 }, { b: 2 }, { b: 3 }]);
    expect(r.order).toEqual(['T', 'Left', 'Right', 'Merge']);
    expect(r.runData.Merge![0]!.data.main[0]![2]!.pairedItem).toEqual({ item: 1, input: 1 });
  });

  it('still runs when one branch is never taken', async () => {
    const r = await run(
      wf(
        [
          ['T', 'manual'],
          ['People', 'test.emit', emit(people)],
          ['If', 'if', ifAgeOver(10)],
          ['Adults', 'noop', {}, { position: [600, 0] }],
          ['Kids', 'noop', {}, { position: [600, 200] }],
          ['Merge', 'merge', { mode: 'append' }, { position: [800, 100] }],
          ['After', 'noop', {}, { position: [1000, 100] }],
        ],
        [['T', 'People'], ['People', 'If'], ['If', 'Adults', 0], ['If', 'Kids', 1], ['Adults', 'Merge', 0, 0], ['Kids', 'Merge', 0, 1], ['Merge', 'After']],
      ),
    );
    expect(r.status).toBe('success');
    expect(r.runData.Kids).toBeUndefined();
    expect(r.runData.Merge).toHaveLength(1);
    expect(r.runData.Merge![0]!.source[1]).toBeNull();
    expect(out(r, 'After')).toHaveLength(3);
  });

  const users = [{ id: 1, name: 'Ada' }, { id: 2, name: 'Alan' }, { id: 3, name: 'Grace' }];
  const orders = [{ id: 1, total: 10 }, { id: 3, total: 30 }, { id: 9, total: 90 }];
  const combine = (extra: Record<string, unknown>) => ({ mode: 'combine', combineBy: 'combineByFields', fieldsToMatchString: 'id', ...extra });

  it('combines by matching fields: keep matches (inner join)', async () => {
    const r = await run(twoBranches(combine({}), users, orders));
    expect(out(r, 'Merge')).toEqual([{ id: 1, name: 'Ada', total: 10 }, { id: 3, name: 'Grace', total: 30 }]);
  });

  it('combines by matching fields: enrich input 1 (left join) and input 2 (right join)', async () => {
    const left = await run(twoBranches(combine({ joinMode: 'enrichInput1' }), users, orders));
    expect(out(left, 'Merge')).toEqual([{ id: 1, name: 'Ada', total: 10 }, { id: 2, name: 'Alan' }, { id: 3, name: 'Grace', total: 30 }]);
    const right = await run(twoBranches(combine({ joinMode: 'enrichInput2' }), users, orders));
    expect(out(right, 'Merge')).toEqual([{ id: 1, name: 'Ada', total: 10 }, { id: 3, name: 'Grace', total: 30 }, { id: 9, total: 90 }]);
  });

  it('combines by matching fields: keep non-matches and keep everything', async () => {
    const non = await run(twoBranches(combine({ joinMode: 'keepNonMatches' }), users, orders));
    expect(out(non, 'Merge')).toEqual([{ id: 2, name: 'Alan' }, { id: 9, total: 90 }]);
    const all = await run(twoBranches(combine({ joinMode: 'keepEverything' }), users, orders));
    expect(out(all, 'Merge')).toHaveLength(4);
  });

  it('combines by fields with different names, fuzzy compare and clash handling', async () => {
    const r = await run(
      twoBranches(
        {
          mode: 'combine',
          combineBy: 'combineByFields',
          fieldsHaveDifferentNames: true,
          mergeByFields: { values: [{ field1: 'email', field2: 'mail' }] },
          options: { fuzzyCompare: true, clashHandling: 'preferInput1' },
        },
        [{ email: 'ADA@x.io', name: 'Ada' }],
        [{ mail: 'ada@x.io', name: 'Countess' }],
      ),
    );
    expect(out(r, 'Merge')).toEqual([{ email: 'ADA@x.io', mail: 'ada@x.io', name: 'Ada' }]);
  });

  it('combines by position, all combinations, and chooses a branch', async () => {
    const pos = await run(twoBranches({ mode: 'combine', combineBy: 'combineByPosition' }, [{ a: 1 }, { a: 2 }], [{ b: 1 }]));
    expect(out(pos, 'Merge')).toEqual([{ a: 1, b: 1 }]);
    const unpaired = await run(
      twoBranches({ mode: 'combine', combineBy: 'combineByPosition', options: { includeUnpaired: true } }, [{ a: 1 }, { a: 2 }], [{ b: 1 }]),
    );
    expect(out(unpaired, 'Merge')).toEqual([{ a: 1, b: 1 }, { a: 2 }]);
    const cross = await run(twoBranches({ mode: 'combine', combineBy: 'combineAll' }, [{ a: 1 }, { a: 2 }], [{ b: 1 }, { b: 2 }]));
    expect(out(cross, 'Merge')).toHaveLength(4);
    const choose = await run(twoBranches({ mode: 'chooseBranch', useDataOfInput: 2 }, [{ a: 1 }], [{ b: 2 }]));
    expect(out(choose, 'Merge')).toEqual([{ b: 2 }]);
  });
});

describe('loops', () => {
  it('Loop Over Items processes batches and outputs everything on "done"', async () => {
    const r = await run(
      wf(
        [
          ['T', 'manual'],
          ['Numbers', 'test.emit', emit([1, 2, 3, 4, 5].map((n) => ({ n })))],
          ['Loop', 'loop', { batchSize: 2 }],
          ['Double', 'set', { assignments: { assignments: [{ name: 'double', value: '={{ $json.n * 2 }}', type: 'number' }] }, includeOtherFields: true }],
          ['Done', 'noop'],
        ],
        [['T', 'Numbers'], ['Numbers', 'Loop'], ['Loop', 'Done', 0], ['Loop', 'Double', 1], ['Double', 'Loop']],
      ),
    );
    expect(r.status).toBe('success');
    expect(r.runData.Double).toHaveLength(3);
    expect(r.runData.Loop).toHaveLength(4);
    expect(out(r, 'Double', 0, 2)).toEqual([{ n: 5, double: 10 }]);
    expect(out(r, 'Done').map((j) => j.double)).toEqual([2, 4, 6, 8, 10]);
  });

  it('stops endless loops with a clear message', async () => {
    const r = await run(wf([['T', 'manual'], ['A', 'noop'], ['B', 'noop']], [['T', 'A'], ['A', 'B'], ['B', 'A']]), { maxNodeRuns: 50 });
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Stopped after 50 node executions');
    expect(r.error?.hint).toMatch(/loops forever/);
  });
});

describe('per-node settings', () => {
  const one = emit([{ id: 1 }]);

  it('retries a failing node until it succeeds', async () => {
    const r = await run(
      wf(
        [['T', 'manual'], ['Data', 'test.emit', one], ['Flaky', 'test.flaky', { key: 'retry-ok', failures: 2 }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 0 }]],
        [['T', 'Data'], ['Data', 'Flaky']],
      ),
    );
    expect(r.status).toBe('success');
    expect(out(r, 'Flaky')).toEqual([{ id: 1, attempts: 3 }]);
  });

  it('gives up after the maximum number of tries', async () => {
    const r = await run(
      wf(
        [['T', 'manual'], ['Data', 'test.emit', one], ['Flaky', 'test.flaky', { key: 'retry-fail', failures: 5 }, { retryOnFail: true, maxTries: 2, waitBetweenTries: 10 }]],
        [['T', 'Data'], ['Data', 'Flaky']],
      ),
    );
    expect(r.status).toBe('error');
    expect(r.error?.message).toBe('Attempt 2 failed');
    expect(r.error?.node).toBe('Flaky');
  });

  it('On Error = stop: the execution fails and later nodes do not run', async () => {
    const r = await run(wf([['T', 'manual'], ['Fail', 'test.fail', { message: 'Kaput' }], ['After', 'noop']], [['T', 'Fail'], ['Fail', 'After']]));
    expect(r.status).toBe('error');
    expect(r.error).toMatchObject({ message: 'Kaput', node: 'Fail' });
    expect(r.lastNodeExecuted).toBe('Fail');
    expect(r.runData.Fail![0]!.status).toBe('error');
    expect(r.runData.After).toBeUndefined();
  });

  it('On Error = continue (regular output): passes the error on as an item', async () => {
    const r = await run(
      wf([['T', 'manual'], ['Fail', 'test.fail', { message: 'Kaput' }, { onError: 'continueRegularOutput' }], ['After', 'noop']], [['T', 'Fail'], ['Fail', 'After']]),
    );
    expect(r.status).toBe('success');
    expect(out(r, 'After')).toEqual([{ error: 'Kaput' }]);
    expect(r.runData.Fail![0]!.error?.message).toBe('Kaput');
  });

  it('On Error = continue (error output): failed items go to the extra error output', async () => {
    const r = await run(
      wf(
        [['T', 'manual'], ['Data', 'test.emit', one], ['Fail', 'test.fail', { message: 'Kaput' }, { onError: 'continueErrorOutput' }], ['Ok', 'noop'], ['Handle', 'noop']],
        [['T', 'Data'], ['Data', 'Fail'], ['Fail', 'Ok', 0], ['Fail', 'Handle', 1]],
      ),
    );
    expect(r.status).toBe('success');
    expect(r.runData.Ok).toBeUndefined();
    expect(out(r, 'Handle')).toEqual([{ id: 1, error: 'Kaput' }]);
  });

  const mixed = emit([{ id: 1 }, { id: 2, bad: true }, { id: 3 }]);
  it('per-item errors with error output: good items continue, bad items are routed', async () => {
    const r = await run(
      wf(
        [['T', 'manual'], ['Data', 'test.emit', mixed], ['Check', 'test.fail', { perItemField: 'bad' }, { onError: 'continueErrorOutput' }]],
        [['T', 'Data'], ['Data', 'Check']],
      ),
    );
    expect(out(r, 'Check', 0).map((j) => j.id)).toEqual([1, 3]);
    expect(out(r, 'Check', 1)).toEqual([{ id: 2, bad: true, error: 'Item 2 is bad' }]);
  });

  it('per-item errors with regular output and with stop', async () => {
    const cont = await run(
      wf([['T', 'manual'], ['Data', 'test.emit', mixed], ['Check', 'test.fail', { perItemField: 'bad' }, { onError: 'continueRegularOutput' }]], [['T', 'Data'], ['Data', 'Check']]),
    );
    expect(out(cont, 'Check')).toEqual([{ id: 1, ok: true }, { error: 'Item 2 is bad' }, { id: 3, ok: true }]);
    const stop = await run(wf([['T', 'manual'], ['Data', 'test.emit', mixed], ['Check', 'test.fail', { perItemField: 'bad' }]], [['T', 'Data'], ['Data', 'Check']]));
    expect(stop.status).toBe('error');
    expect(stop.error).toMatchObject({ message: 'Item 2 is bad', itemIndex: 1 });
  });

  it('Execute Once only processes the first item', async () => {
    const r = await run(wf([['T', 'manual'], ['People', 'test.emit', emit(people)], ['Once', 'noop', {}, { executeOnce: true }]], [['T', 'People'], ['People', 'Once']]));
    expect(out(r, 'Once').map((j) => j.name)).toEqual(['Ada']);
  });

  it('a disabled node passes its input through unchanged', async () => {
    const r = await run(
      wf(
        [['T', 'manual'], ['People', 'test.emit', emit(people)], ['Off', 'if', ifAgeOver(50), { disabled: true }], ['After', 'noop']],
        [['T', 'People'], ['People', 'Off'], ['Off', 'After', 0]],
      ),
    );
    expect(r.runData.Off![0]!.status).toBe('disabled');
    expect(out(r, 'After')).toHaveLength(3);
  });
});

describe('pinned data', () => {
  const pinned = (mode: 'manual' | 'trigger') =>
    run(
      wf([['T', 'manual'], ['Source', 'test.counter', { key: 'pinned-source' }], ['After', 'noop']], [['T', 'Source'], ['Source', 'After']], {
        pinData: { Source: [{ json: { pinned: true } }] },
      }),
      { mode, startNode: 'T' },
    );

  it('uses pinned output instead of executing the node (manual runs)', async () => {
    const r = await pinned('manual');
    expect(counters.get('pinned-source')).toBeUndefined();
    expect(r.runData.Source![0]!.status).toBe('pinned');
    expect(out(r, 'After')).toEqual([{ pinned: true }]);
  });

  it('ignores pinned data in production runs', async () => {
    const r = await pinned('trigger');
    expect(counters.get('pinned-source')).toBe(1);
    expect(out(r, 'After')).toEqual([{}]);
  });
});

describe('partial runs (execute step)', () => {
  const chain = () =>
    wf(
      [
        ['T', 'manual'],
        ['A', 'test.counter', { key: 'A' }],
        ['B', 'test.counter', { key: 'B' }],
        ['C', 'test.counter', { key: 'C' }],
        ['Side', 'test.counter', { key: 'Side' }, { position: [200, 300] }],
      ],
      [['T', 'A'], ['A', 'B'], ['B', 'C'], ['T', 'Side']],
    );

  it('without previous data: runs the needed ancestors and stops at the destination', async () => {
    const r = await run(chain(), { destinationNode: 'B' });
    expect(r.order).toEqual(['T', 'A', 'B']);
    expect(counters.get('C')).toBeUndefined();
    expect(counters.get('Side')).toBeUndefined();
  });

  it('reuses previous data and re-runs only the destination', async () => {
    const first = await run(chain());
    counters.clear();
    const r = await run(chain(), { destinationNode: 'B', previousRunData: first.runData });
    expect(counters.get('A')).toBeUndefined();
    expect(counters.get('B')).toBe(1);
    expect(r.runData.A![0]!.status).toBe('reused');
    expect(r.runData.B![0]!.status).toBe('success');
  });

  it('re-runs everything after a node that has no previous data', async () => {
    const first = await run(chain());
    const previous = { ...first.runData };
    delete previous.A;
    counters.clear();
    await run(chain(), { destinationNode: 'C', previousRunData: previous });
    expect(counters.get('A')).toBe(1);
    expect(counters.get('B')).toBe(1);
    expect(counters.get('C')).toBe(1);
  });

  it('a node without a trigger in front runs with one empty item', async () => {
    const r = await run(wf([['Lonely', 'test.counter', { key: 'lonely' }]], []), { destinationNode: 'Lonely' });
    expect(r.status).toBe('success');
    expect(out(r, 'Lonely')).toEqual([{}]);
  });
});

describe('timeout and cancel', () => {
  it('stops a slow execution at the timeout', async () => {
    const started = Date.now();
    const r = await run(wf([['T', 'manual'], ['Slow', 'test.slow', { ms: 5000 }]], [['T', 'Slow']]), { timeoutMs: 150 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.status).toBe('error');
    expect(r.error?.message).toMatch(/timed out after 0.2 s|timed out after 0.1 s/);
    expect(r.runData.Slow![0]!.status).toBe('error');
  });

  it('can be canceled', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const r = await run(wf([['T', 'manual'], ['Slow', 'test.slow', { ms: 5000 }]], [['T', 'Slow']]), { signal: controller.signal });
    expect(r.status).toBe('canceled');
    expect(r.error?.message).toBe('Execution was stopped');
  });
});

describe('paired items and expressions across nodes', () => {
  it("$('Node').item follows each item through IF, Sort and disabled nodes", async () => {
    const r = await run(
      wf(
        [
          ['T', 'manual'],
          ['People', 'test.emit', emit(people)],
          ['Sort', 'sort', { sortFieldsUi: { sortField: [{ fieldName: 'age', order: 'descending' }] } }],
          ['Off', 'noop', {}, { disabled: true }],
          ['If', 'if', ifAgeOver(0)],
          ['Label', 'set', { assignments: { assignments: [{ name: 'origin', value: "={{ $('People').item.json.name }}-{{ $('Sort').item.json.age }}", type: 'string' }] } }],
        ],
        [['T', 'People'], ['People', 'Sort'], ['Sort', 'Off'], ['Off', 'If'], ['If', 'Label', 0]],
      ),
    );
    expect(r.status).toBe('success');
    expect(out(r, 'Label').map((j) => j.origin)).toEqual(['Grace-85', 'Alan-41', 'Ada-36']);
  });

  it('reports expression errors with the node and parameter', async () => {
    const r = await run(
      wf([['T', 'manual'], ['Bad', 'set', { assignments: { assignments: [{ name: 'x', value: '={{ $json.a.b.c }}', type: 'string' }] } }]], [['T', 'Bad']]),
    );
    expect(r.status).toBe('error');
    expect(r.error).toMatchObject({ node: 'Bad', name: 'ExpressionError', description: 'Parameter "assignments"' });
    expect(r.error?.hint).toMatch(/optional chaining/);
  });
});
