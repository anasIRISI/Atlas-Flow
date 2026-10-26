// Prompt of the AI Workflow Builder. It contains ONLY: the rules, the node catalog (built from the registry) and the
// user's text. No credential value, no .env value, no existing workflow is ever added here.
import type { Catalog } from './catalog.js';

export const MAX_PREVIOUS_ANSWER_CHARS = 8000;

/** Valid against the real catalog (checked by a test). */
export const EXAMPLE_ANSWER = {
  name: 'Greeting',
  nodes: [
    { name: 'Start', type: 'flowforge.manualTrigger', parameters: {} },
    { name: 'Make greeting', type: 'flowforge.set', parameters: { assignments: { assignments: [{ name: 'greeting', value: 'Hello!', type: 'string' }] } } },
  ],
  connections: [{ from: 'Start', to: 'Make greeting' }],
  notes: ['Click Execute Workflow to run it.'],
};

const SHAPE = `{
  "name": string,                       // short workflow title
  "nodes": [ { "name": string, "type": string, "parameters": object } ],
  "connections": [ { "from": string, "to": string, "fromOutput"?: number, "toInput"?: number, "type"?: "main" | "ai_languageModel" | "ai_memory" | "ai_tool" } ],
  "notes"?: string[]                    // up to 5 short hints: what the user must configure next
}`;

function aiSection(catalog: Catalog): string {
  const parents = catalog.entries.filter((e) => e.aiSlots.length > 0);
  if (parents.length === 0) return '';
  const subs = catalog.entries.filter((e) => e.aiOutput);
  const lines = [
    '',
    'AI nodes (cluster nodes):',
    `- Nodes with "AI slots" (${parents.map((p) => p.type).join(', ')}) use sub-nodes (${subs.map((s) => s.type).join(', ') || 'none available'}).`,
    '- A sub-node connects FROM the sub-node TO its parent, and the connection "type" is the slot type, e.g. { "from": "<sub-node name>", "to": "<parent name>", "type": "ai_languageModel" }. Do not set fromOutput / toInput on them.',
    '- Fill every slot marked REQUIRED; respect "max". A sub-node must be attached to a parent. The parent itself gets its normal "main" connection from the previous node.',
  ];
  return lines.join('\n');
}

export function buildSystemInstruction(catalog: Catalog): string {
  return `You design workflows for FlowForge, an automation tool like n8n. Turn the user's request into ONE workflow.

Reply with a single JSON object and nothing else (no markdown, no comments), with this shape:
${SHAPE}

Rules:
1. Use ONLY node types from the catalog below, copied exactly (the "flowforge.xxx" string). Never invent a node type or a parameter name.
2. Start with a trigger node (Manual Trigger if the user does not say how it starts). Triggers have no input, nothing connects into them.
3. Node names are unique, short and readable ("Get weather", "Send email"). "from" and "to" are node names.
4. Connections: "fromOutput" is the output index (default 0). A node with several outputs (IF: 0 = true, 1 = false; Switch: one per case) must use the right index. "toInput" is the input index (default 0). Only use indexes that exist (in:N out:...).
5. Parameters: use only the names listed in the catalog. A "*" marks a required parameter. For "a|b|c" the value must be one of them. Leave out optional parameters you do not need. "@x=y" means "only used when x is y".
6. Expressions: a value that starts with "=" is an expression, e.g. "={{ $json.email }}" or "=Hello {{ $json.name }}". Data of an earlier node: "={{ $('Node name').item.json.field }}". Plain text has no "=".
7. NEVER write secrets (API keys, passwords, tokens). Credentials are added by the user later in the Credentials page; do not put them in parameters. For ids you cannot know use obvious placeholders: "you@example.com", "YOUR_CHAT_ID", "https://example.com".
8. Keep it small and working: usually 2 to 8 nodes. Do not add nodes the request does not need.
9. Shapes of special parameter types:
   - assignments: { "assignments": [ { "name": "field", "value": "text or ={{ expr }}", "type": "string|number|boolean|array|object" } ] }
   - conditions: { "conditions": [ { "leftValue": "={{ $json.age }}", "rightValue": 18, "operator": { "type": "number", "operation": "gt" } } ], "combinator": "and" } (types: string, number, boolean, dateTime, array, object; string operations: equals, notEquals, contains, startsWith, endsWith, regex, empty, notEmpty; number: equals, notEquals, gt, gte, lt, lte; boolean: true, false)
   - keyValue: [ { "name": "key", "value": "text" } ]
   - collection ("options"): an object with only the listed names. fixedCollection: an object with the listed group names, each a list of objects.
   - formFields: { "values": [ { "fieldLabel": "Email", "fieldType": "text|email|number|textarea|dropdown|radio|checkbox|date|file|hiddenField|password", "requiredField": true } ] }
   - json: an object or JSON text. code: a string of JavaScript (Code node: use $input.all() and return an array of { json: {...} }).
   - multiOptions: a list of allowed values.${aiSection(catalog)}

Node catalog (type "Name" [group] in = main inputs, out = output labels):
${catalog.text}

Example of a valid answer:
${JSON.stringify(EXAMPLE_ANSWER)}`;
}

export interface BuilderPrompt {
  systemInstruction: string;
  prompt: string;
}

export function buildPrompt(catalog: Catalog, userText: string): BuilderPrompt {
  return { systemInstruction: buildSystemInstruction(catalog), prompt: `User request:\n${userText}` };
}

/** Second (and last) attempt: the conversation so far + the numbered error list. */
export function buildRetryPrompt(catalog: Catalog, userText: string, previousAnswer: string, errors: string[]): BuilderPrompt & { history: { role: 'user' | 'model'; text: string }[] } {
  const previous = previousAnswer.length > MAX_PREVIOUS_ANSWER_CHARS ? `${previousAnswer.slice(0, MAX_PREVIOUS_ANSWER_CHARS)}…` : previousAnswer;
  return {
    systemInstruction: buildSystemInstruction(catalog),
    history: [
      { role: 'user', text: `User request:\n${userText}` },
      { role: 'model', text: previous },
    ],
    prompt: `Your previous answer is not a valid FlowForge workflow. Problems found:\n${errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n\nFix every problem and reply with the complete corrected JSON object only.`,
  };
}
