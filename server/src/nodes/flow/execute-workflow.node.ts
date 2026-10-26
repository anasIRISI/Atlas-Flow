import type { Item, WorkflowData } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode, type SubWorkflowRequest } from '../../engine/types.js';

export default defineNode({
  description: {
    type: 'flowforge.executeWorkflow',
    displayName: 'Execute Workflow',
    description: 'Runs another workflow (sub-workflow) and returns its result.',
    icon: 'lucide:workflow',
    group: 'flow',
    version: 1,
    defaults: { name: 'Execute Workflow', color: '#ff6d5a' },
    subtitle: '{{mode}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['sub-workflow', 'subworkflow', 'call', 'run', 'function'],
  },
  properties: [
    {
      name: 'source',
      displayName: 'Source',
      type: 'options',
      default: 'database',
      options: [
        { name: 'From the List', value: 'database', description: 'A workflow saved in FlowForge' },
        { name: 'Define Below (JSON)', value: 'parameter', description: 'Paste the workflow JSON' },
      ],
    },
    { name: 'workflowId', displayName: 'Workflow', type: 'workflowSelector', default: '', displayOptions: { show: { source: ['database'] } } },
    {
      name: 'workflowJson',
      displayName: 'Workflow JSON',
      type: 'json',
      default: '{\n  "nodes": [],\n  "connections": {}\n}',
      displayOptions: { show: { source: ['parameter'] } },
    },
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'options',
      default: 'once',
      options: [
        { name: 'Run Once with All Items', value: 'once' },
        { name: 'Run Once for Each Item', value: 'each' },
      ],
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          name: 'waitForSubWorkflow',
          displayName: 'Wait for Sub-Workflow Completion',
          type: 'boolean',
          default: true,
          description: 'Off = start it and continue right away with the input items.',
        },
      ],
    },
  ],
  async execute(ctx) {
    const items = ctx.getInputData();
    const wait = ctx.getNodeParameter<boolean>('options.waitForSubWorkflow', 0, true);
    let target: Pick<SubWorkflowRequest, 'workflowId' | 'workflow'>;
    if (ctx.getNodeParameter('source', 0) === 'parameter') {
      let value = ctx.getNodeParameter<unknown>('workflowJson', 0);
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch (err) {
          throw new NodeOperationError('The workflow JSON is not valid', { description: (err as Error).message });
        }
      }
      const wf = value as Partial<WorkflowData>;
      if (!wf || !Array.isArray(wf.nodes)) throw new NodeOperationError('The workflow JSON needs a "nodes" list');
      target = { workflow: { name: wf.name || 'Inline workflow', nodes: wf.nodes, connections: wf.connections ?? {}, settings: wf.settings } };
    } else {
      const id = String(ctx.getNodeParameter('workflowId', 0, '') ?? '').trim();
      if (!id) throw new NodeOperationError('Choose the workflow to execute');
      target = { workflowId: id };
    }

    if (ctx.getNodeParameter('mode', 0) === 'each') {
      const out: Item[] = [];
      for (let i = 0; i < items.length; i++) {
        const result = await ctx.executeWorkflow({ ...target, items: [items[i]!], wait });
        out.push(...result.map((item) => ({ ...item, pairedItem: { item: i } })));
      }
      return [out];
    }
    return [await ctx.executeWorkflow({ ...target, items, wait })];
  },
});
