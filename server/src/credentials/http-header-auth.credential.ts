import { defineCredential } from './types.js';

export default defineCredential({
  name: 'httpHeaderAuth',
  displayName: 'Header Auth',
  description: 'A secret HTTP header (e.g. X-API-Key: …): protects a Webhook, or sends an API key (HTTP Request).',
  icon: 'key-round',
  docsAnchor: '#webhook-authentication',
  properties: [
    { name: 'name', displayName: 'Header Name', type: 'string', default: 'X-API-Key', required: true },
    { name: 'value', displayName: 'Header Value', type: 'string', password: true, required: true },
  ],
});
