import { createHash, createHmac, getHashes, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { JsonObject, NodeProperty } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { writeField } from '../_shared/fields.js';

const ALGORITHMS = ['MD5', 'SHA1', 'SHA256', 'SHA384', 'SHA512', 'SHA3-256', 'SHA3-512'].filter((a) => getHashes().includes(a.toLowerCase()));
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const show = (...action: string[]): NodeProperty['displayOptions'] => ({ show: { action } });

export default defineNode({
  description: {
    type: 'flowforge.crypto',
    displayName: 'Crypto',
    description: 'Hash a value (MD5, SHA…), sign it with HMAC, or generate a random string or UUID.',
    icon: 'lucide:fingerprint-pattern',
    group: 'transform',
    version: 1,
    defaults: { name: 'Crypto', color: '#9b6dd7' },
    subtitle: '{{action}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['hash', 'hmac', 'md5', 'sha256', 'uuid', 'random', 'signature', 'checksum', 'token'],
  },
  properties: [
    {
      name: 'action',
      displayName: 'Action',
      type: 'options',
      default: 'hash',
      options: [
        { name: 'Hash', value: 'hash', description: 'Fingerprint of a text or a file' },
        { name: 'HMAC', value: 'hmac', description: 'Hash signed with a secret (webhook signatures)' },
        { name: 'Generate', value: 'generate', description: 'Random string or UUID' },
      ],
    },
    { name: 'type', displayName: 'Type', type: 'options', default: 'SHA256', options: ALGORITHMS.map((a) => ({ name: a, value: a })), displayOptions: show('hash', 'hmac') },
    { name: 'binaryData', displayName: 'Binary File', type: 'boolean', default: false, description: 'Hash a file of the item instead of a text.', displayOptions: show('hash', 'hmac') },
    { name: 'binaryPropertyName', displayName: 'Binary Property', type: 'string', default: 'data', displayOptions: { show: { action: ['hash', 'hmac'], binaryData: [true] } } },
    { name: 'value', displayName: 'Value', type: 'string', default: '', placeholder: 'e.g. {{ $json.email }}', displayOptions: { show: { action: ['hash', 'hmac'], binaryData: [false] } } },
    {
      name: 'secret',
      displayName: 'Secret',
      type: 'string',
      default: '',
      typeOptions: { password: true },
      description: 'Shared secret of the signature. It is saved with the workflow.',
      displayOptions: show('hmac'),
    },
    {
      name: 'encoding',
      displayName: 'Encoding',
      type: 'options',
      default: 'hex',
      options: [
        { name: 'HEX', value: 'hex' },
        { name: 'BASE64', value: 'base64' },
      ],
      displayOptions: show('hash', 'hmac'),
    },
    {
      name: 'encodingType',
      displayName: 'Type',
      type: 'options',
      default: 'uuid',
      options: [
        { name: 'UUID', value: 'uuid' },
        { name: 'Letters and Digits', value: 'ascii' },
        { name: 'HEX', value: 'hex' },
        { name: 'BASE64', value: 'base64' },
      ],
      displayOptions: show('generate'),
    },
    { name: 'stringLength', displayName: 'Length', type: 'number', default: 32, typeOptions: { minValue: 1, maxValue: 4096 }, displayOptions: { show: { action: ['generate'], encodingType: ['ascii', 'hex', 'base64'] } } },
    { name: 'dataPropertyName', displayName: 'Output Field Name', type: 'string', default: 'data', description: 'Field the result is written to.' },
  ],
  async execute(ctx) {
    const out = await ctx.forEachItem(async (item, i) => {
      const action = String(ctx.getNodeParameter('action', i, 'hash'));
      const property = String(ctx.getNodeParameter('dataPropertyName', i, 'data') || 'data');
      let result: string;
      if (action === 'generate') {
        const kind = String(ctx.getNodeParameter('encodingType', i, 'uuid'));
        const length = Math.floor(Number(ctx.getNodeParameter('stringLength', i, 32)));
        if (kind !== 'uuid' && !(length >= 1 && length <= 4096)) throw new NodeOperationError('Length must be between 1 and 4096', { itemIndex: i });
        if (kind === 'uuid') result = randomUUID();
        else if (kind === 'ascii') result = Array.from({ length }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
        else result = randomBytes(length).toString(kind === 'hex' ? 'hex' : 'base64').slice(0, length);
      } else {
        const algorithm = String(ctx.getNodeParameter('type', i, 'SHA256'));
        if (!ALGORITHMS.includes(algorithm)) throw new NodeOperationError(`Unknown hash type "${algorithm}"`, { itemIndex: i, hint: `Available: ${ALGORITHMS.join(', ')}` });
        const encoding = ctx.getNodeParameter<string>('encoding', i, 'hex') === 'base64' ? 'base64' : 'hex';
        const data =
          ctx.getNodeParameter<boolean>('binaryData', i, false) === true
            ? await ctx.helpers.getBinaryDataBuffer(i, String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data'))
            : Buffer.from(String(ctx.getNodeParameter('value', i, '') ?? ''), 'utf8');
        if (action === 'hmac') {
          const secret = String(ctx.getNodeParameter('secret', i, ''));
          if (!secret) throw new NodeOperationError('The HMAC secret is empty', { itemIndex: i, hint: 'Enter the secret shared with the other system.' });
          result = createHmac(algorithm.toLowerCase(), secret).update(data).digest(encoding);
        } else result = createHash(algorithm.toLowerCase()).update(data).digest(encoding);
      }
      const json: JsonObject = structuredClone(item.json);
      writeField(json, property, result);
      return { json, ...(item.binary ? { binary: item.binary } : {}) };
    });
    return [out];
  },
});
