import { defineCredential } from './types.js';

export default defineCredential({
  name: 'httpBasicAuth',
  displayName: 'Basic Auth',
  description: 'User and password (HTTP Basic authentication): protects a Webhook, or signs in to an API (HTTP Request).',
  icon: 'lock',
  docsAnchor: '#webhook-authentication',
  properties: [
    { name: 'user', displayName: 'User', type: 'string', required: true },
    { name: 'password', displayName: 'Password', type: 'string', password: true, required: true },
  ],
});
