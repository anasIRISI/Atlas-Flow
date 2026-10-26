import { defineNode, type AiMemory } from '../../engine/types.js';

export default defineNode({
  description: {
    type: 'flowforge.simpleMemory',
    displayName: 'Simple Memory',
    description: 'Remembers the last messages of each chat session so the agent keeps the context.',
    icon: 'lucide:brain',
    group: 'ai-sub',
    version: 1,
    defaults: { name: 'Simple Memory', color: '#0ea5e9' },
    subtitle: '{{sessionKey}}',
    inputs: [],
    outputs: [{ type: 'ai_memory', displayName: 'Memory' }],
    keywords: ['memory', 'chat', 'history', 'session', 'context', 'agent'],
  },
  properties: [
    {
      name: 'sessionKey',
      displayName: 'Session ID',
      type: 'string',
      default: '={{ $json.sessionId }}',
      description: 'What identifies one conversation: the sessionId of the Chat Trigger, a Telegram chat id…',
    },
    {
      name: 'contextWindow',
      displayName: 'Context Window Length',
      type: 'number',
      default: 10,
      typeOptions: { minValue: 1, maxValue: 100 },
      description: 'How many earlier messages (questions and answers) the agent sees.',
    },
  ],
  supplyData(ctx, itemIndex): AiMemory {
    const sessionId = String(ctx.getNodeParameter('sessionKey', itemIndex, '') ?? '');
    const raw = Number(ctx.getNodeParameter('contextWindow', itemIndex, 10));
    const window = Math.min(Math.max(Math.floor(Number.isFinite(raw) ? raw : 10), 1), 100);
    // Throws a clear error when the session id is empty.
    const memory = ctx.getChatMemory(sessionId);
    return {
      sessionId: sessionId.trim(),
      load() {
        const turns = memory.load(window);
        // A conversation sent to the model starts with a user message.
        while (turns.length && turns[0]!.role !== 'user') turns.shift();
        return turns;
      },
      save: (turns) => memory.append(turns),
      clear: () => memory.clear(),
    };
  },
});
