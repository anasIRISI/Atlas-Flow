import { defaultConditions, type ConditionsValue, type NodeProperty } from '@flowforge/shared';
import { evaluateConditions } from '../../engine/conditions.js';
import type { ExecuteContext } from '../../engine/types.js';

/** The "Conditions" parameter used by IF and Filter. */
export const conditionsProperty: NodeProperty = {
  name: 'conditions',
  displayName: 'Conditions',
  type: 'conditions',
  default: defaultConditions(),
};

export const conditionOptionsProperty: NodeProperty = {
  name: 'options',
  displayName: 'Options',
  type: 'collection',
  default: {},
  placeholder: 'Add option',
  options: [
    { name: 'ignoreCase', displayName: 'Ignore Case', type: 'boolean', default: false },
    {
      name: 'looseTypeValidation',
      displayName: 'Convert Types Where Required',
      type: 'boolean',
      default: false,
      description: 'Compare "25" (text) with 25 (number) instead of reporting a type error.',
    },
  ],
};

/** Evaluates the node's conditions for one item. */
export function itemMatches(ctx: ExecuteContext, itemIndex: number, parameter = 'conditions'): boolean {
  const conditions = ctx.getNodeParameter<ConditionsValue>(parameter, itemIndex);
  return evaluateConditions(conditions, {
    ignoreCase: ctx.getNodeParameter<boolean>('options.ignoreCase', itemIndex, false) || undefined,
    looseTypeValidation: ctx.getNodeParameter<boolean>('options.looseTypeValidation', itemIndex, false) || undefined,
    itemIndex,
  });
}
