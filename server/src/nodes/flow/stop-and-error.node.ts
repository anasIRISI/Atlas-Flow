import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';

export default defineNode({
  description: {
    type: 'flowforge.stopAndError',
    displayName: 'Stop and Error',
    description: 'Stops the workflow with an error (which also starts the error workflow).',
    icon: 'lucide:octagon-x',
    group: 'flow',
    version: 1,
    defaults: { name: 'Stop and Error', color: '#ff6d5a' },
    subtitle: '{{errorType}}',
    inputs: [{ type: 'main' }],
    outputs: [],
    keywords: ['throw', 'fail', 'exception'],
  },
  properties: [
    {
      name: 'errorType',
      displayName: 'Error Type',
      type: 'options',
      default: 'errorMessage',
      options: [
        { name: 'Error Message', value: 'errorMessage' },
        { name: 'Error Object', value: 'errorObject' },
      ],
    },
    {
      name: 'errorMessage',
      displayName: 'Error Message',
      type: 'string',
      default: '',
      required: true,
      displayOptions: { show: { errorType: ['errorMessage'] } },
    },
    {
      name: 'errorObject',
      displayName: 'Error Object',
      type: 'json',
      default: '{\n  "code": "404",\n  "message": "Not found"\n}',
      displayOptions: { show: { errorType: ['errorObject'] } },
    },
  ],
  execute(ctx) {
    const type = ctx.getNodeParameter<string>('errorType', 0);
    if (type === 'errorObject') {
      let value = ctx.getNodeParameter<unknown>('errorObject', 0);
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          throw new NodeOperationError('The error object is not valid JSON');
        }
      }
      const obj = (value ?? {}) as Record<string, unknown>;
      const message = typeof obj.message === 'string' ? obj.message : JSON.stringify(obj);
      throw new NodeOperationError(message, { description: JSON.stringify(obj) });
    }
    const message = ctx.getNodeParameter<string>('errorMessage', 0, '');
    throw new NodeOperationError(message || 'Workflow stopped by the "Stop and Error" node');
  },
});
