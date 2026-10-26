// Docs: https://ai.google.dev/api/generate-content (client: server/src/integrations/gemini.ts)
import type { JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode, type ExecuteContext } from '../../engine/types.js';
import { GEMINI_DEFAULT_MODEL, GEMINI_MODELS, MAX_INLINE_BYTES, generateContent, type GeminiImage, type GeminiRequest } from '../../integrations/gemini.js';
import { toNodeError } from '../../integrations/errors.js';

const CREDENTIAL = 'googlePalmApi';

/** `model` parameter → model id: Default = the credential (which falls back to GEMINI_MODEL, then gemini-3.8-flash). */
function resolveModel(ctx: ExecuteContext, itemIndex: number, credentialModel: unknown): string {
  const choice = String(ctx.getNodeParameter('model', itemIndex, 'default'));
  if (choice === 'custom') {
    const custom = String(ctx.getNodeParameter('customModel', itemIndex, '')).trim();
    if (!custom) throw new NodeOperationError('The custom model name is empty', { itemIndex, hint: `Enter a model id such as ${GEMINI_DEFAULT_MODEL}, or choose a model from the list.` });
    return custom;
  }
  if (choice !== 'default') return choice;
  return String(credentialModel ?? '').trim() || GEMINI_DEFAULT_MODEL;
}

async function readImages(ctx: ExecuteContext, itemIndex: number): Promise<GeminiImage[]> {
  if (ctx.getNodeParameter<boolean>('sendImages', itemIndex, false) !== true) return [];
  const properties = String(ctx.getNodeParameter('binaryPropertyName', itemIndex, 'data'))
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const item = ctx.getInputData()[itemIndex];
  const images: GeminiImage[] = [];
  let total = 0;
  for (const property of properties) {
    const ref = item?.binary?.[property];
    if (!ref) {
      throw new NodeOperationError(`Item ${itemIndex} has no binary property "${property}"`, {
        itemIndex,
        hint: `Binary properties of this item: ${Object.keys(item?.binary ?? {}).join(', ') || 'none'}. Use their names, separated by commas, or turn "Send Images" off.`,
      });
    }
    const mimeType = ref.mimeType ?? '';
    if (!/^image\//i.test(mimeType)) {
      throw new NodeOperationError(`"${property}" is a file of type "${mimeType || 'unknown'}", not an image`, { itemIndex, hint: 'Only images (image/png, image/jpeg, image/webp…) can be sent to Gemini.' });
    }
    const data = await ctx.helpers.getBinaryDataBuffer(itemIndex, property);
    total += data.byteLength;
    if (total > MAX_INLINE_BYTES) {
      throw new NodeOperationError(`The images are too big to send (more than ${MAX_INLINE_BYTES / 1024 / 1024} MB in total)`, { itemIndex, hint: 'Send fewer or smaller images (resize them first).' });
    }
    images.push({ mimeType, data });
  }
  return images;
}

const optionalNumber = (value: unknown): number | undefined => (value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value));

export default defineNode({
  description: {
    type: 'flowforge.googleGemini',
    displayName: 'Google Gemini',
    description: 'Asks Google Gemini: text prompt, optional images, JSON output.',
    icon: 'lucide:sparkles',
    group: 'integration',
    version: 1,
    defaults: { name: 'Google Gemini', color: '#8b5cf6' },
    subtitle: '{{model}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    credentials: [{ type: CREDENTIAL, required: true }],
    keywords: ['gemini', 'google', 'ai', 'llm', 'gpt', 'chat', 'prompt', 'vision', 'image'],
  },
  properties: [
    {
      name: 'model',
      displayName: 'Model',
      type: 'options',
      default: 'default',
      options: [
        { name: 'Default (credential / GEMINI_MODEL)', value: 'default', description: 'The model of the credential, else GEMINI_MODEL in .env, else gemini-3.8-flash' },
        ...GEMINI_MODELS.map((id) => ({ name: id, value: id })),
        { name: 'Custom…', value: 'custom', description: 'Any model id' },
      ],
    },
    { name: 'customModel', displayName: 'Custom Model', type: 'string', default: '', placeholder: GEMINI_DEFAULT_MODEL, displayOptions: { show: { model: ['custom'] } } },
    { name: 'prompt', displayName: 'Prompt', type: 'string', default: '', required: true, typeOptions: { rows: 5 }, placeholder: 'e.g. Summarize this text: {{ $json.text }}' },
    { name: 'systemInstruction', displayName: 'System Instruction', type: 'string', default: '', typeOptions: { rows: 3 }, description: 'Optional: how the model should behave (role, tone, format).' },
    {
      name: 'memory',
      displayName: 'Conversation Memory',
      type: 'options',
      default: 'none',
      options: [
        { name: 'Off', value: 'none', description: 'Every prompt stands alone' },
        { name: 'Remember the Conversation', value: 'session', description: 'Earlier messages of the same chat session are sent along (Chat Trigger, Telegram…)' },
      ],
    },
    {
      name: 'sessionKey',
      displayName: 'Session ID',
      type: 'string',
      default: '={{ $json.sessionId }}',
      description: 'What identifies one conversation: the sessionId of the Chat Trigger, a Telegram chat id…',
      displayOptions: { show: { memory: ['session'] } },
    },
    {
      name: 'contextWindow',
      displayName: 'Messages to Remember',
      type: 'number',
      default: 10,
      typeOptions: { minValue: 1, maxValue: 100 },
      description: 'How many earlier messages (questions and answers) are sent with each prompt.',
      displayOptions: { show: { memory: ['session'] } },
    },
    { name: 'jsonOutput', displayName: 'JSON Mode', type: 'boolean', default: false, description: 'The answer is JSON; the parsed object is in the "json" field of the output.' },
    { name: 'sendImages', displayName: 'Send Images', type: 'boolean', default: false, description: 'Adds image files of the item (binary data) to the prompt.' },
    {
      name: 'binaryPropertyName',
      displayName: 'Binary Property',
      type: 'string',
      default: 'data',
      description: 'Name of the binary property holding the image. Several: separate with commas.',
      displayOptions: { show: { sendImages: [true] } },
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'temperature', displayName: 'Temperature', type: 'number', default: 1, typeOptions: { minValue: 0, maxValue: 2 }, description: '0 = precise, 2 = creative.' },
        { name: 'maxOutputTokens', displayName: 'Max Output Tokens', type: 'number', default: 2048, typeOptions: { minValue: 1 }, description: 'Thinking tokens count too: do not set it too low.' },
        { name: 'topP', displayName: 'Top P', type: 'number', default: 0.95, typeOptions: { minValue: 0, maxValue: 1 } },
        { name: 'topK', displayName: 'Top K', type: 'number', default: 40, typeOptions: { minValue: 1 } },
        { name: 'maxRetries', displayName: 'Max Retries', type: 'number', default: 2, typeOptions: { minValue: 0, maxValue: 5 }, description: 'Retries when Gemini is busy (429 with a short wait, 500, 503).' },
        { name: 'timeout', displayName: 'Timeout (Seconds)', type: 'number', default: 60, typeOptions: { minValue: 1, maxValue: 600 } },
      ],
    },
  ],
  /** Demo Mode: a plausible answer (no key, nothing is sent to Gemini). */
  simulate() {
    return { text: 'This is a simulated Gemini answer: add a Google Gemini API key to get real ones.', model: 'simulated' };
  },

  async execute(ctx) {
    const credential = await ctx.getCredentials(CREDENTIAL);
    const apiKey = String(credential.data.apiKey ?? '').trim();
    const host = String(credential.data.host ?? '').trim() || undefined;

    const out = await ctx.forEachItem(async (_item, i) => {
      const prompt = String(ctx.getNodeParameter('prompt', i, '') ?? '');
      if (!prompt.trim()) throw new NodeOperationError('The prompt is empty', { itemIndex: i, hint: 'Write the question or instruction, or use an expression such as {{ $json.text }}.' });
      const options = ctx.getNodeParameter<JsonObject>('options', i, {});
      const memory = String(ctx.getNodeParameter('memory', i, 'none')) === 'session' ? ctx.getChatMemory(String(ctx.getNodeParameter('sessionKey', i, '') ?? '')) : undefined;
      const window = Math.min(Math.max(Math.floor(optionalNumber(ctx.getNodeParameter('contextWindow', i, 10)) ?? 10), 1), 100);
      // A conversation sent to Gemini starts with a user message.
      const history = memory?.load(window) ?? [];
      while (history.length && history[0]!.role !== 'user') history.shift();
      const request: GeminiRequest = {
        model: resolveModel(ctx, i, credential.data.model),
        prompt,
        history,
        systemInstruction: String(ctx.getNodeParameter('systemInstruction', i, '') ?? ''),
        images: await readImages(ctx, i),
        temperature: optionalNumber(options.temperature),
        maxOutputTokens: optionalNumber(options.maxOutputTokens),
        topP: optionalNumber(options.topP),
        topK: optionalNumber(options.topK),
        json: ctx.getNodeParameter<boolean>('jsonOutput', i, false) === true,
        maxRetries: optionalNumber(options.maxRetries) ?? 2,
      };
      const timeoutMs = Math.min(Math.max(optionalNumber(options.timeout) ?? 60, 1), 600) * 1000;
      try {
        const result = await generateContent({ apiKey, host }, request, { signal: ctx.signal, timeoutMs });
        memory?.append([
          { role: 'user', text: prompt },
          { role: 'model', text: result.text },
        ]);
        const json: JsonObject = { text: result.text };
        if (result.json !== undefined) json.json = result.json as JsonObject;
        json.model = result.model;
        json.finishReason = result.finishReason;
        json.usage = result.usage;
        return { json };
      } catch (err) {
        throw toNodeError(err, { credentialType: CREDENTIAL, credential, envVars: 'GEMINI_API_KEY', docsAnchor: '#google-gemini', itemIndex: i });
      }
    });
    return [out];
  },
});
