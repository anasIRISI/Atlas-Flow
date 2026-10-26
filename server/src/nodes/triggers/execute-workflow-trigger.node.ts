import { defineNode } from '../../engine/types.js';

export default defineNode({
  description: {
    type: 'flowforge.executeWorkflowTrigger',
    displayName: 'Execute Workflow Trigger',
    description: 'Starts this workflow when another workflow runs it with an "Execute Workflow" node.',
    icon: 'lucide:log-in',
    group: 'trigger',
    version: 1,
    defaults: { name: 'When Executed by Another Workflow', color: '#ff6d5a' },
    inputs: [],
    outputs: [{ type: 'main' }],
    trigger: { kind: 'event' },
    keywords: ['sub-workflow', 'subworkflow', 'call', 'function', 'reuse'],
  },
  properties: [
    {
      name: 'notice',
      displayName: 'The items sent by the calling workflow arrive here. The output of this workflow\'s last node is returned to the caller.',
      type: 'notice',
      default: '',
    },
  ],
  // Manual run (not called by another workflow): one empty item.
  execute: () => [[{ json: {} }]],
});
