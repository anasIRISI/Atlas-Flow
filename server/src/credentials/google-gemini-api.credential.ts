import { GEMINI_DEFAULT_MODEL, generateContent } from '../integrations/gemini.js';
import { IntegrationError } from '../integrations/errors.js';
import { FlowError } from '../engine/errors.js';
import { defineCredential } from './types.js';

export default defineCredential({
  name: 'googlePalmApi',
  displayName: 'Google Gemini API',
  description: 'An API key from Google AI Studio (Google Gemini node).',
  icon: 'sparkles',
  docsAnchor: '#google-gemini',
  properties: [
    { name: 'apiKey', displayName: 'API Key', type: 'string', password: true, required: true, env: 'GEMINI_API_KEY', description: 'Create it at aistudio.google.com/apikey.' },
    {
      name: 'model',
      displayName: 'Default Model',
      type: 'string',
      default: 'gemini-3.8-flash',
      env: 'GEMINI_MODEL',
      description: 'Used when a node leaves the model on "Default". Free-tier models: gemini-3.8-flash, gemini-3.6-flash, gemini-3.5-flash-lite.',
    },
    { name: 'host', displayName: 'Host', type: 'string', default: 'https://generativelanguage.googleapis.com', env: 'GEMINI_API_URL', description: 'Change it only when you use a proxy.' },
  ],
  envRequired: ['GEMINI_API_KEY'],
  async test(data, options) {
    const model = String(data.model || GEMINI_DEFAULT_MODEL);
    try {
      await generateContent(
        { apiKey: String(data.apiKey ?? ''), host: String(data.host ?? '') || undefined },
        { model, prompt: 'Reply with the single word OK.', maxRetries: 0 },
        // Thinking models can take 10-20 s on a slow connection: same limit as the AI Workflow Builder.
        { signal: options.signal, timeoutMs: 45_000 },
      );
      return { ok: true, message: `The key works (model ${model} answered).` };
    } catch (err) {
      if (err instanceof IntegrationError || err instanceof FlowError) return { ok: false, message: err.message, hint: err.hint };
      throw err;
    }
  },
});
