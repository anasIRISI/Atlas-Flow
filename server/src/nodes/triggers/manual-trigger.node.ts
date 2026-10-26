import { defineNode } from '../../engine/types.js';

export default defineNode({
  description: {
    type: 'flowforge.manualTrigger',
    displayName: 'Manual Trigger',
    description: 'Starts the workflow when you click "Execute workflow" in the editor.',
    icon: 'lucide:mouse-pointer-click',
    group: 'trigger',
    version: 1,
    defaults: { name: 'When clicking "Execute workflow"', color: '#909298' },
    inputs: [],
    outputs: [{ type: 'main' }],
    trigger: { kind: 'manual' },
    keywords: ['start', 'click', 'test'],
  },
  properties: [
    {
      name: 'notice',
      displayName: 'This node is where the workflow starts when you click "Execute workflow".',
      type: 'notice',
      default: '',
    },
  ],
  execute: () => [[{ json: {} }]],
});
