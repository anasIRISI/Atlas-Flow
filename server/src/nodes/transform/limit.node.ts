import { defineNode } from '../../engine/types.js';

export default defineNode({
  description: {
    type: 'flowforge.limit',
    displayName: 'Limit',
    description: 'Keeps only the first (or last) N items.',
    icon: 'lucide:list-end',
    group: 'transform',
    version: 1,
    defaults: { name: 'Limit', color: '#9b6dd7' },
    subtitle: 'Max {{maxItems}} items',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['top', 'first', 'last', 'head', 'tail'],
  },
  properties: [
    { name: 'maxItems', displayName: 'Max Items', type: 'number', default: 1, typeOptions: { minValue: 1 } },
    {
      name: 'keep',
      displayName: 'Keep',
      type: 'options',
      default: 'firstItems',
      options: [
        { name: 'First Items', value: 'firstItems' },
        { name: 'Last Items', value: 'lastItems' },
      ],
    },
  ],
  execute(ctx) {
    const items = ctx.getInputData();
    const max = Math.max(0, Math.floor(Number(ctx.getNodeParameter('maxItems', 0, 1))));
    const keep = ctx.getNodeParameter<string>('keep', 0);
    return [keep === 'lastItems' ? items.slice(Math.max(0, items.length - max)) : items.slice(0, max)];
  },
});
