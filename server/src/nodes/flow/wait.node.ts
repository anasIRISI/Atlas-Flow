import { FORM_THEMES, type NodeProperty } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';

/** Waits up to this long are done in memory; longer ones are saved and resumed (also after a restart). */
export const waitLimits = { inMemoryMaxMs: Number(process.env.FLOWFORGE_WAIT_IN_MEMORY_MAX_SECONDS ?? 65) * 1000 };

const UNIT_MS: Record<string, number> = { seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
const show = (resume: string[], extra: Record<string, unknown[]> = {}): NodeProperty['displayOptions'] => ({ show: { resume, ...extra } });
const unitOptions = Object.keys(UNIT_MS).map((u) => ({ name: u.charAt(0).toUpperCase() + u.slice(1), value: u }));

export default defineNode({
  description: {
    type: 'flowforge.wait',
    displayName: 'Wait',
    description: 'Pauses the workflow for a time, until a date, or until a webhook call / form submission.',
    icon: 'lucide:hourglass',
    group: 'flow',
    version: 1,
    defaults: { name: 'Wait', color: '#ff6d5a' },
    subtitle: '{{resume}}',
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['delay', 'sleep', 'pause', 'approval', 'resume'],
  },
  properties: [
    {
      name: 'resume',
      displayName: 'Resume',
      type: 'options',
      default: 'timeInterval',
      options: [
        { name: 'After Time Interval', value: 'timeInterval' },
        { name: 'At Specified Time', value: 'specificTime' },
        { name: 'On Webhook Call', value: 'webhook' },
        { name: 'On Form Submitted', value: 'form' },
      ],
    },
    { name: 'amount', displayName: 'Wait Amount', type: 'number', default: 5, typeOptions: { minValue: 0 }, displayOptions: show(['timeInterval']) },
    { name: 'unit', displayName: 'Wait Unit', type: 'options', default: 'seconds', options: unitOptions, displayOptions: show(['timeInterval']) },
    { name: 'dateTime', displayName: 'Date and Time', type: 'dateTime', default: '', displayOptions: show(['specificTime']) },
    {
      name: 'webhookNotice',
      displayName: 'The workflow continues when {{ $execution.resumeUrl }} is called. Send that URL earlier in the workflow (e.g. by email).',
      type: 'notice',
      default: '',
      displayOptions: show(['webhook']),
    },
    {
      name: 'httpMethod',
      displayName: 'HTTP Method',
      type: 'options',
      default: 'GET',
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ name: m, value: m })),
      displayOptions: show(['webhook']),
    },
    {
      name: 'responseMode',
      displayName: 'Respond',
      type: 'options',
      default: 'onReceived',
      options: [
        { name: 'Immediately', value: 'onReceived' },
        { name: 'When Last Node Finishes', value: 'lastNode' },
        { name: "Using 'Respond to Webhook' Node", value: 'responseNode' },
      ],
      displayOptions: show(['webhook']),
    },
    {
      name: 'formNotice',
      displayName: 'The workflow continues when the form at {{ $execution.resumeFormUrl }} is submitted.',
      type: 'notice',
      default: '',
      displayOptions: show(['form']),
    },
    { name: 'formTitle', displayName: 'Form Title', type: 'string', default: 'Please confirm', displayOptions: show(['form']) },
    { name: 'formDescription', displayName: 'Form Description', type: 'string', default: '', typeOptions: { rows: 2 }, displayOptions: show(['form']) },
    {
      name: 'formTheme',
      displayName: 'Theme',
      type: 'options',
      default: 'midnight',
      options: FORM_THEMES.map((t) => ({ name: t.label, value: t.value })),
      typeOptions: { editorHidden: true },
      noDataExpression: true,
      displayOptions: show(['form']),
    },
    {
      name: 'formFields',
      displayName: 'Form Elements',
      type: 'formFields',
      default: { values: [{ id: 'comment', fieldLabel: 'Comment', fieldType: 'textarea', requiredField: false }] },
      noDataExpression: true,
      displayOptions: show(['form']),
    },
    { name: 'formButtonLabel', displayName: 'Submit Button Text', type: 'string', default: 'Submit', displayOptions: show(['form']) },
    { name: 'formCompletionMessage', displayName: 'Completion Message', type: 'string', default: 'Thank you, your answer was submitted.', displayOptions: show(['form']) },
    { name: 'limitWaitTime', displayName: 'Limit Wait Time', type: 'boolean', default: false, displayOptions: show(['webhook', 'form']) },
    {
      name: 'limitType',
      displayName: 'Limit Type',
      type: 'options',
      default: 'afterTimeInterval',
      options: [
        { name: 'After Time Interval', value: 'afterTimeInterval' },
        { name: 'At Specified Time', value: 'atSpecifiedTime' },
      ],
      displayOptions: show(['webhook', 'form'], { limitWaitTime: [true] }),
    },
    { name: 'resumeAmount', displayName: 'Amount', type: 'number', default: 1, displayOptions: show(['webhook', 'form'], { limitWaitTime: [true], limitType: ['afterTimeInterval'] }) },
    { name: 'resumeUnit', displayName: 'Unit', type: 'options', default: 'hours', options: unitOptions, displayOptions: show(['webhook', 'form'], { limitWaitTime: [true], limitType: ['afterTimeInterval'] }) },
    { name: 'maxDateAndTime', displayName: 'Max Date and Time', type: 'dateTime', default: '', displayOptions: show(['webhook', 'form'], { limitWaitTime: [true], limitType: ['atSpecifiedTime'] }) },
  ],
  async execute(ctx) {
    const input = ctx.getInputData();
    const resume = ctx.getNodeParameter<string>('resume', 0);

    if (resume === 'webhook' || resume === 'form') {
      let resumeAt: Date | null = null;
      if (ctx.getNodeParameter<boolean>('limitWaitTime', 0, false)) {
        if (ctx.getNodeParameter('limitType', 0) === 'atSpecifiedTime') {
          const at = Date.parse(String(ctx.getNodeParameter('maxDateAndTime', 0, '')));
          if (Number.isNaN(at)) throw new NodeOperationError('Enter a valid "Max Date and Time"');
          resumeAt = new Date(at);
        } else {
          const ms = Number(ctx.getNodeParameter('resumeAmount', 0, 1)) * (UNIT_MS[String(ctx.getNodeParameter('resumeUnit', 0, 'hours'))] ?? 3_600_000);
          resumeAt = new Date(Date.now() + ms);
        }
      }
      return ctx.putExecutionToWait(resumeAt, resume);
    }

    let ms: number;
    if (resume === 'specificTime') {
      const at = Date.parse(String(ctx.getNodeParameter('dateTime', 0, '')));
      if (Number.isNaN(at)) throw new NodeOperationError('Enter a valid date and time to wait for');
      ms = at - Date.now();
    } else {
      const amount = Number(ctx.getNodeParameter('amount', 0, 5));
      if (!Number.isFinite(amount) || amount < 0) throw new NodeOperationError('The wait amount must be a positive number');
      ms = amount * (UNIT_MS[String(ctx.getNodeParameter('unit', 0, 'seconds'))] ?? 1000);
    }
    if (ms <= 0) return [input];
    if (ms <= waitLimits.inMemoryMaxMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(ctx.signal.reason);
          },
          { once: true },
        );
      });
      return [input];
    }
    return ctx.putExecutionToWait(new Date(Date.now() + ms), 'time');
  },
});
