// Demo Mode showcase workflow: Form → weather → summary → email + Telegram + Discord. Contract: docs/phase8-contracts.md (W3)
import { randomUUID } from 'node:crypto';
import type { Connections, WorkflowNode } from '@flowforge/shared';

export const DEMO_PROMPT =
  'When someone fills in a form with their email and city, get the weather for that city, email it to them, and post it to Telegram and Discord';

export const DEMO_TAG = 'demo';

const node = (id: string, name: string, type: string, position: [number, number], parameters: Record<string, unknown>, extra: Partial<WorkflowNode> = {}): WorkflowNode =>
  ({ id, name, type: `flowforge.${type}`, typeVersion: 1, position, parameters, ...extra }) as unknown as WorkflowNode;

/** Integration nodes continue on error so one failing service never hides the others. */
const soft = { onError: 'continueRegularOutput' } as const;

export function showcaseWorkflow(): { name: string; nodes: WorkflowNode[]; connections: Connections } {
  const nodes: WorkflowNode[] = [
    node(
      'form',
      'Weather form',
      'formTrigger',
      [0, 0],
      {
        formTitle: 'Weather in your inbox',
        formDescription: 'Tell us where you are and we send you the weather by email, Telegram and Discord.',
        formTheme: 'midnight',
        formFields: {
          values: [
            { id: 'name', fieldLabel: 'Name', fieldType: 'text', requiredField: true, placeholder: 'Your name' },
            { id: 'email', fieldLabel: 'Email', fieldType: 'email', requiredField: true, placeholder: 'you@example.com' },
            { id: 'city', fieldLabel: 'City', fieldType: 'text', requiredField: true, placeholder: 'Paris' },
          ],
        },
        responseMode: 'onReceived',
        options: { successTitle: 'Thank you!', successMessage: 'Your weather report is on its way.' },
      },
      { webhookId: randomUUID() },
    ),
    node('weather', 'Get weather', 'openMeteo', [300, 0], { operation: 'getWeather', locationMode: 'city', city: '={{ $json.City }}', include: ['current'], forecastDays: 1 }, soft),
    node(
      'summary',
      'Write summary',
      'set',
      [600, 0],
      {
        assignments: {
          assignments: [
            {
              id: 'a1',
              name: 'summary',
              type: 'string',
              value: "={{ $json.summary ?? ('Weather for ' + $('Weather form').item.json.City + ' is not available right now.') }}",
            },
            { id: 'a2', name: 'email', type: 'string', value: "={{ $('Weather form').item.json.Email }}" },
            { id: 'a3', name: 'name', type: 'string', value: "={{ $('Weather form').item.json.Name }}" },
          ],
        },
        includeOtherFields: true,
      },
    ),
    node(
      'email',
      'Send email',
      'sendEmail',
      [900, -200],
      {
        toEmail: '={{ $json.email }}',
        subject: '=Your weather report, {{ $json.name }}',
        emailFormat: 'template',
        templateTitle: '=Hello {{ $json.name }}',
        templateMessage: '={{ $json.summary }}',
        templateFooter: 'Sent by FlowForge Demo Mode.',
        templateColor: '#0ea5e9',
      },
      soft,
    ),
    node('telegram', 'Send to Telegram', 'telegram', [900, 0], { operation: 'sendMessage', chatId: '', text: '={{ $json.summary }}', parseMode: 'none' }, soft),
    node(
      'discord',
      'Post to Discord',
      'discord',
      [900, 200],
      { operation: 'sendMessage', content: '=Weather report for {{ $json.name }}: {{ $json.summary }}' },
      soft,
    ),
  ];
  const link = (to: string) => ({ node: to, type: 'main', index: 0 });
  const connections = {
    'Weather form': { main: [[link('Get weather')]] },
    'Get weather': { main: [[link('Write summary')]] },
    'Write summary': { main: [[link('Send email'), link('Send to Telegram'), link('Post to Discord')]] },
  } as unknown as Connections;
  return { name: 'Weather report demo', nodes, connections };
}
