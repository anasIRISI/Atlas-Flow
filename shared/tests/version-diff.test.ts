import { describe, expect, it } from 'vitest';
import type { WorkflowNode } from '../src/index.js';
import { diffWorkflows, isEmptyDiff, stableStringify } from '../src/index.js';

const node = (id: string, name: string, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id, name, type: 'flowforge.noOp', typeVersion: 1, position: [0, 0], parameters: {}, ...extra,
});
const wf = (nodes: WorkflowNode[], extra = {}) => ({ name: 'W', nodes, connections: {}, settings: {}, ...extra });

describe('diffWorkflows', () => {
  it('is empty for the first version and for identical workflows', () => {
    expect(isEmptyDiff(diffWorkflows(null, wf([node('1', 'A')])))).toBe(true);
    expect(isEmptyDiff(diffWorkflows(wf([node('1', 'A')]), wf([node('1', 'A', { disabled: false })])))).toBe(true);
  });
  it('detects added, removed, changed and renamed nodes', () => {
    const d = diffWorkflows(wf([node('1', 'A'), node('2', 'B')]), wf([node('1', 'A2', { parameters: { x: 1 } }), node('3', 'C')]));
    expect(d.added).toEqual(['C']);
    expect(d.removed).toEqual(['B']);
    expect(d.renamed).toEqual([{ from: 'A', to: 'A2' }]);
    expect(d.changed).toEqual([{ node: 'A2', fields: ['parameters'] }]);
  });
  it('reports position, credentials and settings', () => {
    const d = diffWorkflows(
      wf([node('1', 'A')]),
      wf([node('1', 'A', { position: [10, 0], credentials: { smtp: { id: 'x', name: 'n' } } })], { settings: { timezone: 'UTC' }, name: 'Z', connections: { A: { main: [[]] } } }),
    );
    expect(d.changed[0].fields).toEqual(['credentials', 'position']);
    expect(d.settingsChanged && d.nameChanged && d.connectionsChanged).toBe(true);
  });
  it('stableStringify ignores key order', () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(stableStringify({ b: { d: 3, c: 2 }, a: 1 }));
  });
});
