// Small built-in templates for the offline fallback (used together with the files in `examples/`).
// They use ONLY node types that exist in the registry today and the same JSON shape Gemini answers with, so they go
// through the very same validation and layout (a test validates every one of them against the registry).

export interface RawNode {
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
  onError?: 'stopWorkflow' | 'continueRegularOutput' | 'continueErrorOutput';
}

export interface RawConnection {
  from: string;
  to: string;
  fromOutput?: number;
  toInput?: number;
  type?: 'main' | 'ai_languageModel' | 'ai_memory' | 'ai_tool';
}

export interface RawWorkflow {
  name: string;
  nodes: RawNode[];
  connections: RawConnection[];
  notes?: string[];
}

export interface BuiltInTemplate {
  id: string;
  name: string;
  description: string;
  /** Extra words that make the template easier to find (synonyms are added by the scorer). */
  keywords: string;
  workflow: RawWorkflow;
}

export const BUILT_IN_TEMPLATES: BuiltInTemplate[] = [
  {
    id: 'builtin-webhook-json',
    name: 'Webhook that answers with JSON',
    description: 'A public URL that receives a request and answers with a JSON reply built from the query.',
    keywords: 'webhook api endpoint http url request respond response reply answer json rest callback',
    workflow: {
      name: 'Webhook that answers with JSON',
      nodes: [
        { name: 'Webhook', type: 'flowforge.webhook', parameters: { httpMethod: 'GET', responseMode: 'responseNode' } },
        {
          name: 'Build reply',
          type: 'flowforge.set',
          parameters: {
            assignments: {
              assignments: [
                { name: 'ok', value: true, type: 'boolean' },
                { name: 'message', value: "=Hello {{ $json.query.name || 'world' }}!", type: 'string' },
              ],
            },
          },
        },
        { name: 'Respond to Webhook', type: 'flowforge.respondToWebhook', parameters: { respondWith: 'firstIncomingItem' } },
      ],
      connections: [
        { from: 'Webhook', to: 'Build reply' },
        { from: 'Build reply', to: 'Respond to Webhook' },
      ],
      notes: ['Open the Webhook node to copy its test URL, then call it with ?name=Ada.'],
    },
  },
  {
    id: 'builtin-website-down-alert',
    name: 'Website down alert (Discord)',
    description: 'Every 5 minutes the website is checked; if it does not answer or returns an error, an alert is posted to Discord.',
    keywords: 'website site down uptime monitor monitoring alert alarm notify notification status check ping outage availability schedule every minutes discord http error',
    workflow: {
      name: 'Website down alert',
      nodes: [
        { name: 'Every 5 minutes', type: 'flowforge.scheduleTrigger', parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } } },
        {
          name: 'Check website',
          type: 'flowforge.httpRequest',
          parameters: { method: 'GET', url: 'https://example.com', options: { neverError: true, fullResponse: true, timeout: 10000 } },
          onError: 'continueRegularOutput',
        },
        {
          name: 'Is it down?',
          type: 'flowforge.if',
          parameters: {
            conditions: {
              conditions: [{ leftValue: '={{ !$json.statusCode || $json.statusCode >= 400 }}', operator: { type: 'boolean', operation: 'true' } }],
              combinator: 'and',
            },
          },
        },
        {
          name: 'Alert on Discord',
          type: 'flowforge.discord',
          parameters: { operation: 'sendMessage', content: "=🚨 Website down: https://example.com (status {{ $json.statusCode || 'no answer' }})" },
        },
      ],
      connections: [
        { from: 'Every 5 minutes', to: 'Check website' },
        { from: 'Check website', to: 'Is it down?' },
        { from: 'Is it down?', to: 'Alert on Discord', fromOutput: 0 },
      ],
      notes: ['Change the URL in "Check website" to the site you want to watch.'],
    },
  },
  {
    id: 'builtin-rss-to-telegram',
    name: 'RSS feed to Telegram',
    description: 'Every new article of an RSS feed is sent to a Telegram chat.',
    keywords: 'rss feed news blog article post telegram bot message chat notify new channel',
    workflow: {
      name: 'RSS feed to Telegram',
      nodes: [
        { name: 'New article', type: 'flowforge.rssFeedTrigger', parameters: { feedUrl: 'https://feeds.bbci.co.uk/news/rss.xml', pollInterval: 15, pollUnit: 'minutes' } },
        { name: 'Send to Telegram', type: 'flowforge.telegram', parameters: { operation: 'sendMessage', chatId: 'YOUR_CHAT_ID', text: '=📰 {{ $json.title }}\n{{ $json.link }}' } },
      ],
      connections: [{ from: 'New article', to: 'Send to Telegram' }],
      notes: ['Replace YOUR_CHAT_ID with your Telegram chat id and the feed URL with your favourite feed.'],
    },
  },
  {
    id: 'builtin-http-code-summary',
    name: 'Fetch data and summarise it',
    description: 'Fetches a list from a web API and counts the entries with a small Code step.',
    keywords: 'http request api fetch download get data json list code javascript count total summary summarise statistics report manual click run',
    workflow: {
      name: 'Fetch data and summarise it',
      nodes: [
        { name: 'Start', type: 'flowforge.manualTrigger', parameters: {} },
        { name: 'Get todos', type: 'flowforge.httpRequest', parameters: { method: 'GET', url: 'https://jsonplaceholder.typicode.com/todos?_limit=20', options: { splitIntoItems: true } } },
        {
          name: 'Summary',
          type: 'flowforge.code',
          parameters: {
            mode: 'runOnceForAllItems',
            jsCode: "const items = $input.all();\nconst completed = items.filter((i) => i.json.completed).length;\nreturn [{ json: { total: items.length, completed, open: items.length - completed } }];",
          },
        },
      ],
      connections: [
        { from: 'Start', to: 'Get todos' },
        { from: 'Get todos', to: 'Summary' },
      ],
      notes: ['Click Execute Workflow, then open "Summary" to see the result.'],
    },
  },
  {
    id: 'builtin-hello-world',
    name: 'Hello world',
    description: 'The smallest workflow: click a button, a Set step creates a greeting.',
    keywords: 'hello world simple basic first start example test demo manual click set',
    workflow: {
      name: 'Hello world',
      nodes: [
        { name: 'Start', type: 'flowforge.manualTrigger', parameters: {} },
        { name: 'Make greeting', type: 'flowforge.set', parameters: { assignments: { assignments: [{ name: 'greeting', value: 'Hello from FlowForge!', type: 'string' }] } } },
      ],
      connections: [{ from: 'Start', to: 'Make greeting' }],
      notes: ['Click Execute Workflow, then open "Make greeting".'],
    },
  },
];
