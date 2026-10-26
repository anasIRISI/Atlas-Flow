import type { Item } from '@flowforge/shared';
import { toFlowError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { conditionOptionsProperty, conditionsProperty, itemMatches } from '../_shared/conditions.js';

export default defineNode({
  description: {
    type: 'flowforge.if',
    displayName: 'If',
    description: 'Routes items to "true" or "false" depending on conditions.',
    icon: 'lucide:split',
    group: 'flow',
    version: 1,
    defaults: { name: 'If', color: '#4caf50' },
    inputs: [{ type: 'main' }],
    outputs: [
      { type: 'main', displayName: 'true' },
      { type: 'main', displayName: 'false' },
    ],
    keywords: ['condition', 'branch', 'compare', 'when'],
  },
  properties: [conditionsProperty, conditionOptionsProperty],
  execute(ctx) {
    const whenTrue: Item[] = [];
    const whenFalse: Item[] = [];
    ctx.getInputData().forEach((item, i) => {
      try {
        (itemMatches(ctx, i) ? whenTrue : whenFalse).push(item);
      } catch (err) {
        // With "continue (regular output)" a failing item goes to the false branch, like n8n.
        if (!ctx.continueOnFail()) throw toFlowError(err, ctx.node.name);
        whenFalse.push(item);
      }
    });
    return [whenTrue, whenFalse];
  },
});
