import { beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionDetail, NodeTypeInfo, ServerEvent, WorkflowRecord } from '@flowforge/shared';
import { listEdges } from '../src/editor/graph';
import { editor, useEditor } from '../src/editor/store';

const type = (t: string, name: string, extra: Partial<NodeTypeInfo> = {}): NodeTypeInfo => ({
  type: t,
  displayName: name,
  description: '',
  icon: 'lucide:box',
  group: 'transform',
  version: 1,
  defaults: { name },
  inputs: [{ type: 'main' }],
  outputs: [{ type: 'main' }],
  properties: [],
  ...extra,
});
const manual = type('flowforge.manualTrigger', 'Manual', { group: 'trigger', inputs: [] });
const set = type('flowforge.set', 'Edit Fields');

const record: WorkflowRecord = {
  id: 'wf1',
  name: 'Test',
  nodes: [],
  connections: {},
  settings: {},
  pinData: {},
  versionId: 'v1',
  createdAt: '',
  updatedAt: '',
  active: false,
  activationError: null,
  triggerError: null,
  triggerErrorAt: null,
};

const ev = (type: ServerEvent['type'], data: Record<string, unknown>, seq?: number) =>
  ({ type, ts: Date.now(), seq, data: { executionId: '7', workflowId: 'wf1', ...data } }) as unknown as ServerEvent;

beforeEach(() => editor.load(record));

describe('editing', () => {
  it('adds nodes, auto-connects to the selected node and marks the workflow dirty', () => {
    const a = editor.addNode(manual);
    expect(useEditor.getState().selected).toEqual([a.id]);
    const b = editor.addNode(set);
    expect(b.position[0]).toBe(a.position[0] + 240);
    expect(listEdges(useEditor.getState().connections)).toEqual([{ source: 'Manual', output: 0, target: 'Edit Fields', input: 0 }]);
    editor.addNode(set);
    expect(useEditor.getState().nodes.map((n) => n.name)).toEqual(['Manual', 'Edit Fields', 'Edit Fields1']);
    expect(useEditor.getState().dirty).toBe(true);
  });

  it('a trigger is never auto-connected', () => {
    editor.addNode(set);
    editor.addNode(manual);
    expect(useEditor.getState().connections).toEqual({});
  });

  it('undo / redo restore every change, including connections', () => {
    editor.addNode(manual);
    editor.addNode(set);
    editor.deleteNodes(['Manual']);
    expect(useEditor.getState().nodes).toHaveLength(1);
    expect(useEditor.getState().connections).toEqual({});
    editor.undo();
    expect(useEditor.getState().nodes).toHaveLength(2);
    expect(listEdges(useEditor.getState().connections)).toHaveLength(1);
    editor.redo();
    expect(useEditor.getState().nodes).toHaveLength(1);
    editor.undo();
    editor.undo();
    editor.undo();
    expect(useEditor.getState().nodes).toHaveLength(0);
    editor.undo(); // nothing left: no crash
    expect(useEditor.getState().future).toHaveLength(3);
  });

  it('typing in a parameter creates one undo step, not one per key', () => {
    editor.addNode(set);
    for (const v of ['a', 'ab', 'abc']) editor.updateParameters('Edit Fields', { value: v });
    editor.undo();
    expect(useEditor.getState().nodes[0]!.parameters).toEqual({});
  });

  it('rename checks for empty and duplicate names', () => {
    editor.addNode(set);
    editor.addNode(set);
    expect(editor.renameNode('Edit Fields', '  ')).toBe('The name cannot be empty');
    expect(editor.renameNode('Edit Fields', 'Edit Fields1')).toBe('A node named "Edit Fields1" already exists');
    expect(editor.renameNode('Edit Fields', 'Greeting')).toBeNull();
    expect(listEdges(useEditor.getState().connections)[0]!.source).toBe('Greeting');
  });

  it('pin / unpin and disable are undoable changes', () => {
    editor.addNode(set);
    editor.pin('Edit Fields', [{ json: { a: 1 }, pairedItem: { item: 0 } }]);
    expect(useEditor.getState().pinData).toEqual({ 'Edit Fields': [{ json: { a: 1 } }] });
    editor.toggleDisabled(['Edit Fields']);
    expect(useEditor.getState().nodes[0]!.disabled).toBe(true);
    editor.undo();
    editor.undo();
    expect(useEditor.getState().pinData).toEqual({});
  });
});

describe('live execution events', () => {
  beforeEach(() => {
    editor.addNode(manual);
    editor.addNode(set);
    editor.prepareRun();
  });

  it('follows the run: running → success with item counts, edge counts and a log', () => {
    expect(editor.applyEvent(ev('execution.queued', { mode: 'manual' }))).toBeNull();
    expect(useEditor.getState().execution).toMatchObject({ id: '7', status: 'queued' });
    editor.applyEvent(ev('execution.started', { mode: 'manual', startedAt: new Date().toISOString() }, 1));
    editor.applyEvent(ev('node.started', { nodeName: 'Manual', runIndex: 0 }, 2));
    expect(useEditor.getState().execution.nodes.Manual!.status).toBe('running');
    editor.applyEvent(ev('node.finished', { nodeName: 'Manual', runIndex: 0, status: 'success', executionTime: 3, itemCounts: [1], preview: [] }, 3));
    editor.applyEvent(ev('edge.data', { from: { node: 'Manual', output: 0 }, to: { node: 'Edit Fields', input: 0 }, itemCount: 1 }, 4));
    const ex = useEditor.getState().execution;
    expect(ex.nodes.Manual).toMatchObject({ status: 'success', itemCount: 1, runs: 1 });
    expect(Object.values(ex.edges)[0]!.count).toBe(1);
    expect(ex.log).toHaveLength(1);
    expect(editor.applyEvent(ev('execution.finished', { status: 'success', startedAt: '', stoppedAt: new Date().toISOString(), lastNodeExecuted: 'Manual' }, 5))).toBe('finished');
    expect(useEditor.getState().execution.status).toBe('success');
  });

  it('asks for a refetch when a sequence number was missed', () => {
    editor.applyEvent(ev('execution.started', { mode: 'manual', startedAt: new Date().toISOString() }, 1));
    expect(editor.applyEvent(ev('node.started', { nodeName: 'Manual', runIndex: 0 }, 2))).toBeNull();
    expect(editor.applyEvent(ev('node.started', { nodeName: 'Edit Fields', runIndex: 0 }, 5))).toBe('refetch');
  });

  it('ignores events of another execution while one is running', () => {
    editor.applyEvent(ev('execution.started', { mode: 'manual', startedAt: new Date().toISOString() }, 1));
    const other = { ...ev('node.started', { nodeName: 'Manual', runIndex: 0 }, 2), data: { executionId: '99', workflowId: 'wf1', nodeName: 'Manual', runIndex: 0 } } as ServerEvent;
    expect(editor.applyEvent(other)).toBeNull();
    expect(useEditor.getState().execution.nodes.Manual).toBeUndefined();
  });

  it('final state comes from the stored execution (also after missed events)', () => {
    const detail = {
      id: '7',
      status: 'success',
      startedAt: new Date(0).toISOString(),
      stoppedAt: new Date(10).toISOString(),
      error: null,
      events: [{ seq: 1, ts: 0, type: 'node.finished', node: 'Manual', runIndex: 0, status: 'success' }],
      runData: {
        Manual: [{ startTime: 0, executionTime: 1, status: 'success', source: [], data: { main: [[{ json: {} }]] } }],
        'Edit Fields': [{ startTime: 0, executionTime: 1, status: 'success', source: [], data: { main: [[{ json: { a: 1 } }, { json: { a: 2 } }]] } }],
      },
    } as unknown as ExecutionDetail;
    editor.finishFromDetail(detail);
    const s = useEditor.getState();
    expect(s.lastExecutionId).toBe('7');
    expect(s.execution.nodes['Edit Fields']).toMatchObject({ status: 'success', itemCount: 2 });
    expect(Object.values(s.execution.edges)[0]!.count).toBe(1);
    expect(s.runData?.['Edit Fields']?.[0]?.data.main[0]).toHaveLength(2);
  });
});

describe('waiting, activation and test listeners', () => {
  beforeEach(() => {
    editor.addNode(manual);
    editor.addNode(set);
    editor.prepareRun();
    editor.applyEvent(ev('execution.started', { mode: 'manual', startedAt: new Date().toISOString() }, 1));
  });

  it('a waiting execution stays active, and continues when resumed', () => {
    editor.applyEvent(ev('node.started', { nodeName: 'Edit Fields', runIndex: 0 }, 2));
    editor.applyEvent(ev('execution.waiting', { nodeName: 'Edit Fields', waitTill: null, kind: 'webhook', resumeUrl: 'http://x/webhook-waiting/7' }, 3));
    let ex = useEditor.getState().execution;
    expect(ex.status).toBe('waiting');
    expect(ex.waiting).toMatchObject({ node: 'Edit Fields', kind: 'webhook' });
    expect(ex.nodes['Edit Fields']!.status).toBe('waiting');
    editor.applyEvent(ev('execution.started', { mode: 'manual', startedAt: new Date().toISOString() }, 4));
    ex = useEditor.getState().execution;
    expect(ex.status).toBe('running');
    expect(ex.waiting).toBeUndefined();
    expect(ex.nodes['Edit Fields']).toBeUndefined();
  });

  it('follows activation and listener events of this workflow only', () => {
    const wf = (type: ServerEvent['type'], data: Record<string, unknown>) => ({ type, ts: 0, data: { workflowId: 'wf1', ...data } }) as unknown as ServerEvent;
    editor.applyEvent(wf('workflow.activated', {}));
    expect(useEditor.getState().active).toBe(true);
    editor.applyEvent(wf('workflow.activationError', { message: 'Poll: HTTP 500', runtime: true }));
    expect(useEditor.getState()).toMatchObject({ active: true, triggerError: 'Poll: HTTP 500' });
    editor.applyEvent({ ...wf('workflow.deactivated', {}), data: { workflowId: 'other' } } as ServerEvent);
    expect(useEditor.getState().active).toBe(true);
    editor.applyEvent(wf('trigger.listening', { nodeName: 'Webhook', testUrl: 'http://x/webhook-test/a', expiresAt: '' }));
    expect(useEditor.getState().listening?.testUrl).toBe('http://x/webhook-test/a');
    editor.applyEvent(wf('trigger.received', { nodeName: 'Webhook', executionId: '9' }));
    expect(useEditor.getState().listening).toBeNull();
  });
});
