import { describe, expect, it } from 'vitest';
import { buildTimeline, stepInput, stepOutput, timelineEdgeKey, type TimelineSource } from '../src/timeline.js';
import type { ExecutionEvent, NodeRun, NodeRunStatus } from '../src/workflow.js';

const run = (t: number, out: unknown[][], source: NodeRun['source'] = [], status: NodeRunStatus = 'success'): NodeRun => ({
  startTime: t,
  executionTime: 5,
  status,
  source,
  data: { main: out.map((l) => l.map((json) => ({ json: json as Record<string, unknown> }))) },
});
const src = (previousNode: string, previousNodeOutput = 0, previousNodeRun = 0) => ({ previousNode, previousNodeOutput, previousNodeRun });
let seq = 0;
const fin = (node: string, runIndex = 0, status: NodeRunStatus = 'success'): ExecutionEvent => ({ seq: ++seq, ts: seq, type: 'node.finished', node, runIndex, status });
const base = { status: 'success', waitingNode: null } as const;

describe('buildTimeline', () => {
  it('linear: one step per finished node, growing state', () => {
    const d: TimelineSource = {
      ...base,
      runData: { A: [run(1, [[{ a: 1 }]])], B: [run(2, [[{ a: 1 }, { a: 2 }]], [src('A')])] },
      events: [fin('A'), fin('B')],
    };
    const steps = buildTimeline(d);
    expect(steps.map((s) => s.node)).toEqual(['A', 'B']);
    expect(Object.keys(steps[0]!.nodes)).toEqual(['A']);
    expect(steps[0]!.edges).toEqual({});
    expect(steps[1]!.edges[timelineEdgeKey('A', 0, 'B', 0)]).toBe(1);
    expect(steps[1]!.nodes.B).toEqual({ status: 'success', runs: 1, items: 2 });
    expect(stepInput(d, steps[1]!)[0]).toHaveLength(1);
    expect(stepOutput(d, steps[1]!)[0]).toHaveLength(2);
    expect(stepInput(d, steps[0]!)).toEqual([]);
  });

  it('branch: only the taken output carries data', () => {
    const d: TimelineSource = {
      ...base,
      runData: { If: [run(1, [[], [{ x: 1 }]])], No: [run(2, [[{ x: 1 }]], [src('If', 1)])] },
      events: [fin('If'), fin('No')],
    };
    const steps = buildTimeline(d);
    expect(Object.keys(steps[1]!.edges)).toEqual([timelineEdgeKey('If', 1, 'No', 0)]);
    expect(stepInput(d, steps[1]!)[0]![0]!.json).toEqual({ x: 1 });
  });

  it('loop: several runs per node', () => {
    const d: TimelineSource = {
      ...base,
      runData: {
        Loop: [run(1, [[], [{ i: 0 }]]), run(3, [[], [{ i: 1 }]], [src('Work')])],
        Work: [run(2, [[{ i: 0 }]], [src('Loop', 1, 0)]), run(4, [[{ i: 1 }]], [src('Loop', 1, 1)])],
      },
      events: [fin('Loop', 0), fin('Work', 0), fin('Loop', 1), fin('Work', 1)],
    };
    const steps = buildTimeline(d);
    expect(steps.map((s) => `${s.node}#${s.runIndex}`)).toEqual(['Loop#0', 'Work#0', 'Loop#1', 'Work#1']);
    expect(steps[2]!.nodes.Loop!.runs).toBe(2);
    expect(steps[1]!.nodes.Loop!.runs).toBe(1);
    expect(stepInput(d, steps[3]!)[0]![0]!.json).toEqual({ i: 1 });
  });

  it('failed: the error step is last and keeps its status', () => {
    const d: TimelineSource = {
      status: 'error',
      waitingNode: null,
      runData: { A: [run(1, [[{}]])], B: [run(2, [], [src('A')], 'error')] },
      events: [fin('A'), fin('B', 0, 'error')],
    };
    const steps = buildTimeline(d);
    expect(steps.at(-1)).toMatchObject({ node: 'B', status: 'error' });
    expect(steps.at(-1)!.nodes.B!.status).toBe('error');
  });

  it('waiting: adds a final waiting step', () => {
    const d: TimelineSource = { status: 'waiting', waitingNode: 'Wait', runData: { A: [run(1, [[{}]])] }, events: [fin('A')] };
    const steps = buildTimeline(d);
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ node: 'Wait', status: 'waiting', durationMs: null });
    expect(steps[1]!.nodes.Wait!.status).toBe('waiting');
  });

  it('skips events of nodes missing from runData, and AI sub-node runs have no input', () => {
    const d: TimelineSource = {
      ...base,
      runData: { Model: [run(1, [[{ t: 1 }]])] },
      events: [fin('Ghost'), fin('Model')],
    };
    const steps = buildTimeline(d);
    expect(steps.map((s) => s.node)).toEqual(['Model']);
    expect(stepInput(d, steps[0]!)).toEqual([]);
  });

  it('rebuilds the order from start times when there are no events', () => {
    const d: TimelineSource = { ...base, runData: { B: [run(2, [[{}]], [src('A')])], A: [run(1, [[{}]])] }, events: [] };
    expect(buildTimeline(d).map((s) => s.node)).toEqual(['A', 'B']);
  });
});
