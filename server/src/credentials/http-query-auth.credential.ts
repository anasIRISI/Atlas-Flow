import { defineCredential } from './types.js';

export default defineCredential({
  name: 'httpQueryAuth',
  displayName: 'Query Auth',
  description: 'An API key sent in the URL, e.g. ?api_key=… (HTTP Request, GraphQL).',
  icon: 'key-round',
  docsAnchor: '#http-request-authentication',
  properties: [
    { name: 'name', displayName: 'Parameter Name', type: 'string', default: 'api_key', required: true, placeholder: 'e.g. api_key, key, token' },
    { name: 'value', displayName: 'Value', type: 'string', password: true, required: true },
  ],
});
