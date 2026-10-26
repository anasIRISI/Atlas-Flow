import { defaultConditions, type ConditionsValue, type ConnectionSpec, type Item, type JsonObject } from '@flowforge/shared';
import { evaluateConditions } from '../../engine/conditions.js';
import { NodeOperationError, toFlowError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';

interface Rule {
  conditions: ConditionsValue;
  renameOutput?: boolean;
  outputKey?: string;
}

function ruleList(params: JsonObject): Rule[] {
  const rules = (params.rules as { values?: Rule[] } | undefined)?.values;
  return Array.isArray(rules) ? rules : [];
}

function fallbackOf(params: JsonObject): string | number {
  const value = (params.options as JsonObject | undefined)?.fallbackOutput;
  return value === undefined ? 'none' : (value as string | number);
}

export default defineNode({
  description: {
    type: 'flowforge.switch',
    displayName: 'Switch',
    description: 'Routes each item to one of several outputs, based on rules or an expression.',
    icon: 'lucide:signpost',
    group: 'flow',
    version: 1,
    defaults: { name: 'Switch', color: '#8bc34a' },
    subtitle: 'mode: {{mode}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main', displayName: '0' }],
    dynamicOutputs: true,
    keywords: ['route', 'case', 'branch', 'router'],
  },
  properties: [
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'options',
      default: 'rules',
      options: [
        { name: 'Rules', value: 'rules', description: 'Build a matching rule for each output' },
        { name: 'Expression', value: 'expression', description: 'Write an expression that returns the output index' },
      ],
    },
    {
      name: 'rules',
      displayName: 'Routing Rules',
      type: 'fixedCollection',
      default: { values: [{ conditions: defaultConditions(), renameOutput: false, outputKey: '' }] },
      typeOptions: { multipleValues: true },
      displayOptions: { show: { mode: ['rules'] } },
      options: [
        {
          name: 'values',
          displayName: 'Rule',
          values: [
            { name: 'conditions', displayName: 'Conditions', type: 'conditions', default: defaultConditions() },
            { name: 'renameOutput', displayName: 'Rename Output', type: 'boolean', default: false },
            {
              name: 'outputKey',
              displayName: 'Output Name',
              type: 'string',
              default: '',
              displayOptions: { show: { renameOutput: [true] } },
            },
          ],
        },
      ],
    },
    {
      name: 'numberOutputs',
      displayName: 'Number of Outputs',
      type: 'number',
      default: 4,
      typeOptions: { minValue: 1, maxValue: 20 },
      displayOptions: { show: { mode: ['expression'] } },
    },
    {
      name: 'output',
      displayName: 'Output Index',
      type: 'number',
      default: '={{ 0 }}',
      description: 'Expression returning the output (0, 1, 2, …) each item goes to.',
      displayOptions: { show: { mode: ['expression'] } },
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      displayOptions: { show: { mode: ['rules'] } },
      options: [
        {
          name: 'fallbackOutput',
          displayName: 'Fallback Output',
          type: 'options',
          default: 'none',
          description: 'Where items go when no rule matches.',
          options: [
            { name: 'None (ignore item)', value: 'none' },
            { name: 'Extra Output', value: 'extra' },
            { name: 'Output 0', value: 0 },
          ],
        },
        { name: 'allMatchingOutputs', displayName: 'Send to All Matching Outputs', type: 'boolean', default: false },
        { name: 'ignoreCase', displayName: 'Ignore Case', type: 'boolean', default: false },
        { name: 'looseTypeValidation', displayName: 'Convert Types Where Required', type: 'boolean', default: false },
      ],
    },
  ],
  outputs(params): ConnectionSpec[] {
    if (params.mode === 'expression') {
      const n = Math.min(20, Math.max(1, Number(params.numberOutputs) || 4));
      return Array.from({ length: n }, (_, i) => ({ type: 'main', displayName: String(i) }));
    }
    const outputs: ConnectionSpec[] = ruleList(params).map((rule, i) => ({
      type: 'main',
      displayName: rule.renameOutput && rule.outputKey ? rule.outputKey : String(i),
    }));
    if (fallbackOf(params) === 'extra') outputs.push({ type: 'main', displayName: 'Fallback' });
    return outputs.length ? outputs : [{ type: 'main', displayName: '0' }];
  },
  execute(ctx) {
    const items = ctx.getInputData();
    if (ctx.getNodeParameter('mode', 0) === 'expression') {
      const count = Math.min(20, Math.max(1, Number(ctx.getNodeParameter('numberOutputs', 0, 4)) || 4));
      const outputs: Item[][] = Array.from({ length: count }, () => []);
      items.forEach((item, i) => {
        const index = Number(ctx.getNodeParameter('output', i));
        if (!Number.isInteger(index) || index < 0 || index >= count) {
          throw new NodeOperationError(`Output index ${String(index)} is out of range (0–${count - 1})`, { itemIndex: i });
        }
        outputs[index]!.push(item);
      });
      return outputs;
    }

    const ruleCount = ruleList(ctx.node.parameters).length || 1;
    const fallback = ctx.getNodeParameter<string | number>('options.fallbackOutput', 0, 'none');
    const all = ctx.getNodeParameter<boolean>('options.allMatchingOutputs', 0, false);
    const outputs: Item[][] = Array.from({ length: ruleCount + (fallback === 'extra' ? 1 : 0) }, () => []);
    items.forEach((item, i) => {
      try {
        const rules = ctx.getNodeParameter<Rule[]>('rules.values', i, []);
        const ignoreCase = ctx.getNodeParameter<boolean>('options.ignoreCase', i, false) || undefined;
        const looseTypeValidation = ctx.getNodeParameter<boolean>('options.looseTypeValidation', i, false) || undefined;
        let matched = false;
        for (let r = 0; r < rules.length; r++) {
          if (evaluateConditions(rules[r]!.conditions, { ignoreCase, looseTypeValidation, itemIndex: i })) {
            outputs[r]!.push(item);
            matched = true;
            if (!all) break;
          }
        }
        if (!matched) {
          if (fallback === 'extra') outputs[ruleCount]!.push(item);
          else if (typeof fallback === 'number' && outputs[fallback]) outputs[fallback]!.push(item);
        }
      } catch (err) {
        if (!ctx.continueOnFail()) throw toFlowError(err, ctx.node.name);
        outputs[0]!.push(item);
      }
    });
    return outputs;
  },
});
