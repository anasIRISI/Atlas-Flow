import { defineNode } from '../../engine/types.js';

export default defineNode({
  description: {
    type: 'flowforge.errorTrigger',
    displayName: 'Error Trigger',
    description: 'Starts this workflow when another workflow fails (set it as their "Error workflow").',
    icon: 'lucide:triangle-alert',
    group: 'trigger',
    version: 1,
    defaults: { name: 'Error Trigger', color: '#ff6d5a' },
    inputs: [],
    outputs: [{ type: 'main' }],
    trigger: { kind: 'event' },
    keywords: ['failure', 'exception', 'alert', 'monitoring'],
  },
  properties: [
    {
      name: 'notice',
      displayName:
        'Open the workflow to monitor → Workflow settings → Error workflow → choose this workflow. Production failures of that workflow then start this one. A manual run shows example data.',
      type: 'notice',
      default: '',
    },
  ],
  // Manual run: example data with the same shape as a real error.
  execute: () => [
    [
      {
        json: {
          execution: {
            id: '231',
            url: 'http://localhost:5679/executions/231',
            error: { message: 'Example error message', name: 'NodeOperationError', node: 'Node With Error' },
            lastNodeExecuted: 'Node With Error',
            mode: 'trigger',
          },
          workflow: { id: '1', name: 'Example Workflow' },
        },
      },
    ],
  ],
});
