import { defineCredential } from './types.js';

export default defineCredential({
  name: 'httpBearerAuth',
  displayName: 'Bearer Auth',
  description: 'An access token sent as "Authorization: Bearer …" (HTTP Request, GraphQL).',
  icon: 'key-round',
  docsAnchor: '#http-request-authentication',
  properties: [{ name: 'token', displayName: 'Bearer Token', type: 'string', password: true, required: true, description: 'Without the word "Bearer".' }],
});
