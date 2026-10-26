import type { Item } from '@flowforge/shared';
import { defineNode } from '../../engine/types.js';

interface LoopState {
  active?: boolean;
  items?: Item[];
  cursor?: number;
  processed?: Item[];
}

export default defineNode({
  description: {
    type: 'flowforge.splitInBatches',
    displayName: 'Loop Over Items',
    description: 'Processes items in batches: connect "loop" to the steps to repeat and route them back here.',
    icon: 'lucide:repeat',
    group: 'flow',
    version: 1,
    defaults: { name: 'Loop Over Items', color: '#26a69a' },
    subtitle: 'Batch size {{batchSize}}',
    inputs: [{ type: 'main' }],
    outputs: [
      { type: 'main', displayName: 'done' },
      { type: 'main', displayName: 'loop' },
    ],
    keywords: ['batch', 'split in batches', 'iterate', 'for each'],
  },
  properties: [
    {
      name: 'batchSize',
      displayName: 'Batch Size',
      type: 'number',
      default: 1,
      typeOptions: { minValue: 1 },
      description: 'How many items go through the loop at a time.',
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          name: 'reset',
          displayName: 'Reset',
          type: 'boolean',
          default: false,
          description: 'Treat every incoming item list as a new loop (for loops that fetch more data each round).',
        },
      ],
    },
  ],
  execute(ctx) {
    const state = ctx.getNodeState<LoopState>();
    const input = ctx.getInputData();
    const size = Math.max(1, Math.floor(Number(ctx.getNodeParameter('batchSize', 0, 1)) || 1));
    if (!state.active || ctx.getNodeParameter<boolean>('options.reset', 0, false)) {
      // First run: remember every item.
      state.active = true;
      state.items = [...input];
      state.cursor = 0;
      state.processed = [];
    } else {
      // Loop-back run: these are the results of the previous batch.
      state.processed!.push(...input);
    }
    const batch = state.items!.slice(state.cursor!, state.cursor! + size);
    state.cursor! += batch.length;
    if (batch.length > 0) return [[], batch];
    const done = state.processed!;
    state.active = false;
    state.items = [];
    state.processed = [];
    return [done, []];
  },
});
