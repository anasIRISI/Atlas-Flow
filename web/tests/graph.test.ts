import { describe, expect, it } from 'vitest';
import type { Connections, WorkflowNode } from '@flowforge/shared';
import { addEdge, autoLayout, copyPayload, edgeKey, listAllEdges, listEdges, pastePayload, removeEdges, removeNodeConnections, renameInWorkflow, SUB_ROW, uniqueName } from '../src/editor/graph';

const node = (name: string, x = 0, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id: name,
  name,
  type: 'flowforge.noOp',
  typeVersion: 1,
  position: [x, 0],
  parameters: {},
  ...extra,
});

describe('graph helpers', () => {
  it('adds edges without duplicates or self-loops, and removes them', () => {
    let c: Connections = {};
    c = addEdge(c, { source: 'A', output: 0, target: 'B', input: 0 });
    c = addEdge(c, { source: 'A', output: 0, target: 'B', input: 0 });
    c = addEdge(c, { source: 'A', output: 1, target: 'C', input: 0 });
    c = addEdge(c, { source: 'A', output: 0, target: 'A', input: 0 });
    expect(listEdges(c)).toEqual([
      { source: 'A', output: 0, target: 'B', input: 0 },
      { source: 'A', output: 1, target: 'C', input: 0 },
    ]);
    expect(c.A!.main![1]![0]).toEqual({ node: 'C', type: 'main', index: 0 });
    expect(listEdges(removeEdges(c, [{ source: 'A', output: 1, target: 'C', input: 0 }]))).toHaveLength(1);
    expect(removeNodeConnections(c, new Set(['B', 'C']))).toEqual({});
  });

  it('creates n8n-style unique names', () => {
    expect(uniqueName('Edit Fields', new Set())).toBe('Edit Fields');
    expect(uniqueName('Edit Fields', new Set(['Edit Fields']))).toBe('Edit Fields1');
    expect(uniqueName('Edit Fields', new Set(['Edit Fields', 'Edit Fields1']))).toBe('Edit Fields2');
    expect(uniqueName('Code1', new Set(['Code1']))).toBe('Code2');
  });

  it('renames a node everywhere: connections, pinned data and expressions', () => {
    const state = {
      nodes: [
        node('Users'),
        node('Set', 200, { parameters: { a: "={{ $('Users').item.json.x }}", b: '={{ $node["Users"].json.y }}', c: { d: ['={{ $items("Users").length }}'] }, e: 'Users stays' } }),
      ],
      connections: addEdge({}, { source: 'Users', output: 0, target: 'Set', input: 0 }),
      pinData: { Users: [{ json: { x: 1 } }] },
    };
    const out = renameInWorkflow(state, 'Users', 'People');
    expect(out.nodes.map((n) => n.name)).toEqual(['People', 'Set']);
    expect(out.nodes[1]!.parameters).toEqual({
      a: "={{ $('People').item.json.x }}",
      b: '={{ $node["People"].json.y }}',
      c: { d: ['={{ $items("People").length }}'] },
      e: 'Users stays',
    });
    expect(listEdges(out.connections)).toEqual([{ source: 'People', output: 0, target: 'Set', input: 0 }]);
    expect(out.pinData).toEqual({ People: [{ json: { x: 1 } }] });
  });

  it('copies and pastes nodes with their internal connections, renaming conflicts', () => {
    const nodes = [node('A'), node('B', 200), node('C', 400)];
    let c = addEdge({}, { source: 'A', output: 0, target: 'B', input: 0 });
    c = addEdge(c, { source: 'B', output: 0, target: 'C', input: 0 });
    const text = copyPayload(nodes, c, new Set(['A', 'B']));
    const pasted = pastePayload(text, nodes, [40, 40])!;
    expect(pasted.nodes.map((n) => n.name)).toEqual(['A1', 'B1']);
    expect(pasted.nodes[1]!.position).toEqual([240, 40]);
    expect(pasted.nodes[0]!.id).not.toBe('A');
    expect(listEdges(pasted.connections)).toEqual([{ source: 'A1', output: 0, target: 'B1', input: 0 }]);
    expect(pastePayload('not json', nodes, [0, 0])).toBeNull();
    expect(pastePayload('{"nodes":[{"foo":1}]}', nodes, [0, 0])).toBeNull();
  });

  it('auto-layout places connected nodes left to right and ignores sticky notes', () => {
    const nodes = [node('C', 0), node('A', 0), node('B', 0), node('Note', 999, { type: 'flowforge.stickyNote' })];
    let c = addEdge({}, { source: 'A', output: 0, target: 'B', input: 0 });
    c = addEdge(c, { source: 'B', output: 0, target: 'C', input: 0 });
    const pos = autoLayout(nodes, c, (n) => n.type === 'flowforge.stickyNote');
    expect(pos.get('A')![0]).toBeLessThan(pos.get('B')![0]);
    expect(pos.get('B')![0]).toBeLessThan(pos.get('C')![0]);
    expect(pos.has('Note')).toBe(false);
  });

  describe('AI sub-node connections', () => {
    const tool = { source: 'Weather', output: 0, target: 'Agent', input: 0, type: 'ai_tool' as const };
    const model = { source: 'Model', output: 0, target: 'Agent', input: 0, type: 'ai_languageModel' as const };
    const flow = { source: 'Chat', output: 0, target: 'Agent', input: 0 };
    const build = () => [flow, tool, model].reduce(addEdge, {} as Connections);

    it('stores them under their own type, from the sub-node to its parent', () => {
      const c = build();
      expect(c.Weather).toEqual({ ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] });
      expect(c.Chat).toEqual({ main: [[{ node: 'Agent', type: 'main', index: 0 }]] });
      // The data flow only knows main connections.
      expect(listEdges(c)).toEqual([flow]);
      expect(listAllEdges(c)).toEqual(expect.arrayContaining([flow, tool, model]));
      expect(edgeKey(tool)).toBe('ai_tool|Weather:0->Agent:0');
      expect(edgeKey(flow)).toBe('Chat:0->Agent:0');
      expect(addEdge(c, tool)).toBe(c);
    });

    it('keeps them when another connection is removed, and removes them on request', () => {
      const c = removeEdges(build(), [flow]);
      expect(listAllEdges(c)).toEqual(expect.arrayContaining([tool, model]));
      expect(c.Chat).toBeUndefined();
      expect(removeEdges(c, [tool]).Weather).toBeUndefined();
      expect(listAllEdges(removeNodeConnections(build(), new Set(['Agent'])))).toEqual([]);
      expect(listAllEdges(removeNodeConnections(build(), new Set(['Weather'])))).toHaveLength(2);
    });

    it('follows renames, copy and paste', () => {
      const nodes = ['Chat', 'Agent', 'Weather', 'Model'].map((n, i) => node(n, i * 200));
      const renamed = renameInWorkflow({ nodes, connections: build(), pinData: {} }, 'Agent', 'Assistant');
      expect(renamed.connections.Weather!.ai_tool![0]![0]!.node).toBe('Assistant');
      expect(renamed.connections.Chat!.main![0]![0]!.node).toBe('Assistant');
      const again = renameInWorkflow({ nodes, connections: build(), pinData: {} }, 'Weather', 'Forecast');
      expect(again.connections.Forecast).toEqual({ ai_tool: [[{ node: 'Agent', type: 'ai_tool', index: 0 }]] });

      const pasted = pastePayload(copyPayload(nodes, build(), new Set(['Agent', 'Weather', 'Model'])), nodes, [40, 40])!;
      expect(pasted.nodes.map((n) => n.name)).toEqual(['Agent1', 'Weather1', 'Model1']);
      expect(listAllEdges(pasted.connections)).toEqual(
        expect.arrayContaining([
          { ...tool, source: 'Weather1', target: 'Agent1' },
          { ...model, source: 'Model1', target: 'Agent1' },
        ]),
      );
    });

    it('lays sub-nodes out in a row under their parent (chat model first), outside the data flow', () => {
      const nodes = ['Chat', 'Agent', 'Weather', 'Model', 'Reply'].map((n, i) => node(n, i * 10));
      const connections = [flow, tool, model, { source: 'Agent', output: 0, target: 'Reply', input: 0 }].reduce(addEdge, {} as Connections);
      const at = autoLayout(nodes, connections, () => false);
      const [chat, agent, reply, weather, chatModel] = ['Chat', 'Agent', 'Reply', 'Weather', 'Model'].map((n) => at.get(n)!);
      expect(chat![0]).toBeLessThan(agent![0]);
      expect(agent![0]).toBeLessThan(reply![0]);
      expect(weather![1]).toBe(agent![1] + SUB_ROW);
      expect(chatModel![1]).toBe(agent![1] + SUB_ROW);
      expect(chatModel![0]).toBeLessThan(weather![0]);
      // No two nodes share a spot.
      expect(new Set([...at.values()].map((p) => p.join(','))).size).toBe(5);
    });
  });
});

