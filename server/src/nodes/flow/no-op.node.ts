import { defineNode } from '../../engine/types.js';

export default defineNode({
  description: {
    type: 'flowforge.noOp',
    displayName: 'No Operation, do nothing',
    description: 'Passes items through unchanged. Useful as a placeholder or to label a branch.',
    icon: 'lucide:arrow-right',
    group: 'flow',
    version: 1,
    defaults: { name: 'No Operation, do nothing', color: '#b0b0b0' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['noop', 'nothing', 'placeholder'],
  },
  properties: [],
  execute: (ctx) => [ctx.getInputData()],
});
