import { describe, expect, it } from 'vitest';
import type { WorkflowData } from '@flowforge/shared';
import { out, run, wf } from './engine-helpers.js';

/** Start → Harness, with sub-nodes attached to the harness' AI slots (connections go FROM the sub-node). */
function cluster(harness: object, subs: [string, string, object?, object?][], attach: Record<string, 'ai_tool' | 'ai_languageModel' | 'ai_memory'> = {}): WorkflowData {
  const w = wf(
    [['Trigger', 'test.trigger'], ['Start', 'test.emit', { items: [{ who: 'ada' }, { who: 'bob' }] }], ['Harness', 'test.aiHarness', harness], ...subs.map(([name, type, params, extra]) => [name, type, params ?? {}, extra ?? {}] as [string, string, object, object])] as never,
    [['Trigger', 'Start'], ['Start', 'Harness']],
  );
  for (const [name] of subs) w.connections[name] = { [attach[name] ?? 'ai_tool']: [[{ node: 'Harness', type: attach[name] ?? 'ai_tool', index: 0 }]] };
  return w;
}

describe('AI cluster nodes: sub-nodes supply data to their parent', () => {
  it('gives the parent its tools (left to right) and records each tool call as a run of the sub-node', async () => {
    const w = cluster({ tool: 'second', args: { text: 'hi' } }, [
      ['B', 'test.fakeTool', { toolName: 'second', prefix: '=for {{ $json.who }}' }, { position: [500, 300] }],
      ['A', 'test.fakeTool', { toolName: 'first' }, { position: [100, 300] }],
    ]);
    const result = await run(w);
    expect(result.status, JSON.stringify(result.error)).toBe('success');
    // The sub-node's expression is resolved against the parent's current item.
    expect(out(result, 'Harness')).toEqual([
      { tools: ['first', 'second'], hasModel: false, hasMemory: false, result: { echoed: { text: 'hi' }, prefix: 'for ada' } },
      { tools: ['first', 'second'], hasModel: false, hasMemory: false, result: { echoed: { text: 'hi' }, prefix: 'for bob' } },
    ]);
    // One run per call on the tool that was used; the unused tool has no run.
    expect(result.runData.B).toHaveLength(2);
    expect(result.runData.B![0]).toMatchObject({ status: 'success', source: [{ previousNode: 'Harness' }] });
    expect(result.runData.B![0]!.data.main[0]![0]!.json).toEqual({ tool: 'second', input: { text: 'hi' }, output: { echoed: { text: 'hi' }, prefix: 'for ada' } });
    expect(result.runData.A).toBeUndefined();
    expect(result.order.filter((n) => n === 'B')).toHaveLength(2);
  });

  it('reports a failing tool to the parent (which decides what to do) and marks the tool run as failed', async () => {
    const result = await run(cluster({ tool: 'echo', args: { fail: true } }, [['Tool', 'test.fakeTool']]));
    expect(result.status).toBe('success');
    expect(out(result, 'Harness')[0]).toMatchObject({ toolError: 'tool exploded' });
    expect(result.runData.Tool![0]).toMatchObject({ status: 'error', error: { message: 'tool exploded' } });
  });

  it('ignores disabled sub-nodes and never runs a sub-node on its own', async () => {
    const result = await run(cluster({ tool: 'echo' }, [['Tool', 'test.fakeTool', {}, { disabled: true }]]));
    expect(result.status).toBe('success');
    expect(out(result, 'Harness')[0]).toEqual({ tools: [], hasModel: false, hasMemory: false });
    expect(result.runData.Tool).toBeUndefined();
    expect(Object.keys(result.runData).sort()).toEqual(['Harness', 'Start', 'Trigger']);
  });

  it('stops with a clear error on the sub-node when it cannot supply its data', async () => {
    const result = await run(cluster({ tool: 'echo' }, [['Tool', 'test.fakeTool', { prefix: 'BROKEN' }]]));
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ message: 'The fake tool is misconfigured', node: 'Tool' });
    expect(result.runData.Tool![0]!.status).toBe('error');
  });

  it('refuses a node that is not made for the slot it is attached to', async () => {
    const result = await run(cluster({}, [['Wrong', 'test.fakeTool']], { Wrong: 'ai_memory' }));
    // Attached as memory, but it only supplies a tool: the harness asks for its memory and gets the error.
    expect(result.status).toBe('error');
    expect(result.error?.message).toBe('"Wrong" cannot be attached to this slot of "Harness"');
    const plain = await run(cluster({}, [['Set', 'set']], { Set: 'ai_tool' }));
    expect(plain.error?.message).toBe('"Set" cannot be attached to this slot of "Harness"');
  });
});
