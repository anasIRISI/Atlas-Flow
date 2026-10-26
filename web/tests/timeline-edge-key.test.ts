import { describe, expect, it } from 'vitest';
import { buildTimeline, timelineEdgeKey } from '@flowforge/shared';
import { edgeKey } from '../src/editor/graph';

describe('timeline edge keys', () => {
  it('match the editor edgeKey()', () => {
    for (const [source, target] of [['A', 'B'], ['Edit Fields', 'If/Else: ñ'], ['a:b->c', 'd']]) {
      expect(timelineEdgeKey(source!, 1, target!, 2)).toBe(edgeKey({ source: source!, output: 1, target: target!, input: 2 }));
    }
  });

  it('a built timeline uses them', () => {
    const run = (src: object[], n: number) => ({ startTime: n, executionTime: 1, status: 'success' as const, source: src as never, data: { main: [[{ json: {} }]] } });
    const steps = buildTimeline({
      status: 'success',
      waitingNode: null,
      runData: { 'A b': [run([], 1)], 'C d': [run([{ previousNode: 'A b', previousNodeOutput: 0, previousNodeRun: 0 }], 2)] },
      events: [],
    });
    expect(Object.keys(steps[1]!.edges)).toEqual([edgeKey({ source: 'A b', output: 0, target: 'C d', input: 0 })]);
  });
});
