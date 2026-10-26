import type { ConnectionSpec, Item } from '@flowforge/shared';
import { toFlowError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { conditionOptionsProperty, conditionsProperty, itemMatches } from '../_shared/conditions.js';

export default defineNode({
  description: {
    type: 'flowforge.filter',
    displayName: 'Filter',
    description: 'Keeps only the items that match the conditions.',
    icon: 'lucide:funnel',
    group: 'flow',
    version: 1,
    defaults: { name: 'Filter', color: '#229eff' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main', displayName: 'Kept' }],
    dynamicOutputs: true,
    keywords: ['where', 'remove', 'keep', 'condition'],
  },
  properties: [
    conditionsProperty,
    {
      name: 'keepDiscarded',
      displayName: 'Output Discarded Items',
      type: 'boolean',
      default: false,
      description: 'Adds a second output with the items that did not match.',
    },
    conditionOptionsProperty,
  ],
  outputs: (params): ConnectionSpec[] =>
    params.keepDiscarded === true
      ? [{ type: 'main', displayName: 'Kept' }, { type: 'main', displayName: 'Discarded' }]
      : [{ type: 'main', displayName: 'Kept' }],
  execute(ctx) {
    const kept: Item[] = [];
    const discarded: Item[] = [];
    ctx.getInputData().forEach((item, i) => {
      try {
        (itemMatches(ctx, i) ? kept : discarded).push(item);
      } catch (err) {
        if (!ctx.continueOnFail()) throw toFlowError(err, ctx.node.name);
        discarded.push(item);
      }
    });
    return ctx.getNodeParameter<boolean>('keepDiscarded', 0, false) ? [kept, discarded] : [kept];
  },
});
