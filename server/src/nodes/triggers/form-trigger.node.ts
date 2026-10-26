import { FORM_THEMES, normalizeFormFields, type FormFieldDef, type Item, type JsonObject } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { getPath } from '../../engine/params.js';
import { defineNode, type WebhookHandleResult } from '../../engine/types.js';
import {
  formErrorResponse,
  formInvalidResponse,
  formPageResponse,
  formSuccessResponse,
  isBot,
  processSubmission,
  queryStrings,
  themeOf,
  wantsJson,
} from '../_shared/form.js';

const DEFAULT_FIELDS: FormFieldDef[] = [
  { id: 'name', fieldLabel: 'Name', fieldType: 'text', requiredField: true, placeholder: 'Your name' },
  { id: 'email', fieldLabel: 'Email', fieldType: 'email', requiredField: true, placeholder: 'you@example.com' },
  { id: 'message', fieldLabel: 'Message', fieldType: 'textarea', requiredField: false, placeholder: 'How can we help?' },
];

export default defineNode({
  description: {
    type: 'flowforge.formTrigger',
    displayName: 'Form Trigger',
    description: 'Publishes a web form (with a QR code for phones) and starts the workflow on each submission.',
    icon: 'lucide:clipboard-list',
    group: 'trigger',
    version: 1,
    defaults: { name: 'On form submission', color: '#a26bfa' },
    subtitle: '{{formTitle}}',
    inputs: [],
    outputs: [{ type: 'main' }],
    trigger: { kind: 'webhook' },
    keywords: ['form', 'survey', 'contact', 'signup', 'qr', 'submission', 'questionnaire'],
  },
  properties: [
    { name: 'formUrls', displayName: 'Form URLs', type: 'webhookUrls', default: '', typeOptions: { urlPrefix: 'form' } },
    { name: 'formTitle', displayName: 'Form Title', type: 'string', default: 'Contact us', required: true, placeholder: 'e.g. Contact us' },
    {
      name: 'formDescription',
      displayName: 'Form Description',
      type: 'string',
      default: "Leave us a message and we'll get back to you.",
      typeOptions: { rows: 2 },
    },
    {
      name: 'formTheme',
      displayName: 'Theme',
      type: 'options',
      default: 'midnight',
      options: FORM_THEMES.map((t) => ({ name: t.label, value: t.value })),
      typeOptions: { editorHidden: true },
      noDataExpression: true,
    },
    { name: 'formFields', displayName: 'Form Elements', type: 'formFields', default: { values: DEFAULT_FIELDS }, noDataExpression: true },
    {
      name: 'responseMode',
      displayName: 'Show Confirmation',
      type: 'options',
      default: 'onReceived',
      options: [
        { name: 'When the Form Is Submitted', value: 'onReceived', description: 'Right away, while the workflow runs in the background' },
        { name: 'When the Workflow Finishes', value: 'lastNode', description: 'Waits for the workflow; shows an error page if it fails' },
      ],
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        { name: 'path', displayName: 'Form Path', type: 'string', default: '', placeholder: 'e.g. contact', description: 'Readable URL such as /form/contact. Empty = a random id.', noDataExpression: true },
        { name: 'buttonLabel', displayName: 'Submit Button Text', type: 'string', default: 'Submit' },
        { name: 'successTitle', displayName: 'Success Title', type: 'string', default: 'Thank you!' },
        { name: 'successMessage', displayName: 'Success Message', type: 'string', default: 'Your response has been recorded.', typeOptions: { rows: 2 } },
        { name: 'redirectUrl', displayName: 'Redirect URL', type: 'string', default: '', placeholder: 'https://example.com/thanks', description: 'Open this page after submitting instead of the success message.' },
        { name: 'appendAttribution', displayName: 'Show "Powered by FlowForge"', type: 'boolean', default: true },
      ],
    },
  ],
  webhook: {
    urlPrefix: 'form',
    endpoints(node, params) {
      return { methods: ['GET', 'POST'], path: String(getPath(params, 'options.path') || node.webhookId || node.id) };
    },
    async handle({ request, parameters: p, storeBinary }): Promise<WebhookHandleResult> {
      const options = (p.options ?? {}) as JsonObject;
      const mode = request.executionMode === 'test' ? 'test' : 'production';
      const json = wantsJson(request.headers);
      const theme = themeOf(p.formTheme);
      const attribution = options.appendAttribution !== false;
      const fields = normalizeFormFields(p.formFields);
      const page = {
        title: String(p.formTitle || 'Form'),
        description: String(p.formDescription ?? ''),
        fields,
        theme,
        attribution,
        buttonLabel: String(options.buttonLabel || 'Submit'),
        action: request.requestPath,
        query: queryStrings(request.query),
        mode,
      } as const;

      if (request.method === 'GET') return { response: formPageResponse(200, page) };

      const success = {
        title: String(options.successTitle || 'Thank you!'),
        message: String(options.successMessage || 'Your response has been recorded.'),
        redirectUrl: String(options.redirectUrl ?? '').trim() || undefined,
        theme,
        attribution,
      };
      // Bots fill the invisible field: pretend it worked, start nothing.
      if (isBot(request.body)) return { response: formSuccessResponse(json, success) };

      const { result, binary } = await processSubmission(fields, request.body, request.files, storeBinary);
      if (Object.keys(result.errors).length) return { response: formInvalidResponse(json, page, result) };

      const item: Item = {
        json: { ...(result.values as JsonObject), submittedAt: new Date().toISOString(), formMode: mode },
        ...(Object.keys(binary).length ? { binary } : {}),
      };
      return {
        items: [item],
        responseMode: p.responseMode === 'lastNode' ? 'lastNode' : 'onReceived',
        complete: (outcome) => {
          if (!outcome.finished || outcome.status === 'success' || outcome.status === 'waiting') return formSuccessResponse(json, success);
          // Production visitors get a generic message; the test form shows the real error to the builder.
          const detail = mode === 'test' && outcome.error ? `The workflow failed: ${outcome.error}` : 'Your answer was received, but it could not be processed. Please try again later.';
          return formErrorResponse(json, 500, 'Something went wrong', detail, theme);
        },
      };
    },
  },
  execute() {
    throw new NodeOperationError('This node waits for a form submission', {
      hint: 'Click "Listen for test event" and submit the test form, or pin some data on this node.',
    });
  },
});
