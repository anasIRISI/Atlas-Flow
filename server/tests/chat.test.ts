import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Item } from '@flowforge/shared';
import { chatReply, cleanSessionId, renderChatPage } from '../src/nodes/_shared/chat-page.js';
import { answer, apiError, startGeminiMock, type GeminiMock } from './gemini-mock.js';
import { makeTestApp, type TestApp } from './helpers.js';
import { activate, chain, createWorkflow, executions, node, signedIn, type Agent } from './trigger-helpers.js';

let t: TestApp;
let agent: Agent;

beforeEach(async () => {
  t = await makeTestApp();
  agent = await signedIn(t);
});
afterEach(async () => {
  await t?.close();
});

/** Chat Trigger → Code node that answers with the message, the session and how many messages the session had. */
function echoBot(path = 'support', code = 'return [{ json: { output: `You said: ${$json.chatInput}`, session: $json.sessionId, action: $json.action } }];') {
  return {
    name: 'Echo bot',
    nodes: [node('Chat', 'chatTrigger', { title: 'Shop <assistant>', subtitle: 'Ask away', options: { path } }), node('Reply', 'code', { mode: 'runOnceForEachItem', jsCode: code, jsCodeEachItem: code.replace('return [', 'return ').replace('];', ';') })],
    connections: chain('Chat', 'Reply'),
  };
}

const say = (path: string, body: object) => request(t.app).post(path).set('Accept', 'application/json').send(body);

describe('Chat Trigger: hosted page', () => {
  it('serves a self-contained, escaped chat page while the workflow is active', async () => {
    const id = await createWorkflow(agent, echoBot());
    expect((await activate(agent, id)).status).toBe(200);
    const res = await request(t.app).get('/chat/support');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Shop &lt;assistant&gt;');
    expect(res.text).not.toContain('<assistant>');
    expect(res.text).toContain('Ask away');
    expect(res.text).toContain('"action":"/chat/support"');
    // No external resource: works offline and leaks nothing to third parties.
    expect(res.text).not.toMatch(/(src|href)="https?:/);
    expect(executions(t, id)).toHaveLength(0);
  });

  it('explains that the chat is not available when the workflow is inactive', async () => {
    await createWorkflow(agent, echoBot());
    const page = await request(t.app).get('/chat/support');
    expect(page.status).toBe(404);
    expect(page.text).toContain('This chat is not available');
    const api = await say('/chat/support', { chatInput: 'hi' });
    expect(api.status).toBe(404);
    expect(api.body.message).toMatch(/not active/);
  });

  it('cannot break out of the page through the settings', () => {
    const html = renderChatPage({ title: '</title><script>alert(1)</script>', subtitle: '', initialMessages: ['</script><script>alert(2)</script>'], placeholder: '"><img>', accent: 'red;}</style><script>', attribution: true, action: '/chat/x', mode: 'production' });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('"><img>');
    expect(html).toContain('--accent:#f0592a');
    expect(html).toContain('Powered by FlowForge');
  });
});

describe('Chat Trigger: messages', () => {
  it('runs the workflow and answers with the output of the last node', async () => {
    const id = await createWorkflow(agent, echoBot());
    await activate(agent, id);
    const res = await say('/chat/support', { action: 'sendMessage', sessionId: 'abc-123', chatInput: '  Hello there  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ output: 'You said: Hello there', sessionId: 'abc-123' });
    const list = executions(t, id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'success', mode: 'webhook' });
    const detail = t.ctx.executionsRepo.get(list[0]!.id)!;
    expect(detail.runData.Chat![0]!.data.main[0]![0]!.json).toEqual({ sessionId: 'abc-123', action: 'sendMessage', chatInput: 'Hello there' });
  });

  it('creates a session id when the visitor sends none or an unsafe one', async () => {
    const id = await createWorkflow(agent, echoBot());
    await activate(agent, id);
    const none = await say('/chat/support', { chatInput: 'hi' });
    expect(none.body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const unsafe = await say('/chat/support', { chatInput: 'hi', sessionId: '<script>' });
    expect(unsafe.body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(cleanSessionId('ok_id.1-2')).toBe('ok_id.1-2');
    expect(cleanSessionId('a'.repeat(101))).toBeUndefined();
    expect(cleanSessionId(42)).toBeUndefined();
  });

  it('refuses empty, missing and oversized messages without running anything', async () => {
    const id = await createWorkflow(agent, echoBot());
    await activate(agent, id);
    for (const body of [{}, { chatInput: '   ' }, { chatInput: 42 }]) {
      const res = await say('/chat/support', body);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/empty/);
    }
    const long = await say('/chat/support', { chatInput: 'x'.repeat(8001) });
    expect(long.status).toBe(400);
    expect(long.body.message).toMatch(/too long \(8001 characters/);
    expect(executions(t, id)).toHaveLength(0);
  });

  it('hides the error from visitors but shows it to the builder in test mode', async () => {
    const failing = echoBot('oops', 'throw new Error("secret detail 42");');
    const id = await createWorkflow(agent, failing);
    await activate(agent, id);
    const prod = await say('/chat/oops', { chatInput: 'hi' });
    expect(prod.status).toBe(500);
    expect(prod.body.message).toBe('Sorry, something went wrong. Please try again in a moment.');
    expect(JSON.stringify(prod.body)).not.toContain('secret detail');

    const listen = await agent.post(`/api/workflows/${id}/test-listen`).send({ workflow: { ...failing, id }, nodeName: 'Chat' });
    expect(listen.status, JSON.stringify(listen.body)).toBe(200);
    expect(listen.body.testUrl).toMatch(/\/chat-test\/oops$/);
    const test = await say('/chat-test/oops', { chatInput: 'hi' });
    expect(test.status).toBe(500);
    expect(test.body.message).toContain('secret detail 42');
  });

  it('answers one message per test listener (editor chat panel)', async () => {
    const bot = echoBot('panel');
    const id = await createWorkflow(agent, bot);
    const notListening = await say('/chat-test/panel', { chatInput: 'hi' });
    expect(notListening.status).toBe(404);
    expect(notListening.body.message).toMatch(/not listening/);

    await agent.post(`/api/workflows/${id}/test-listen`).send({ workflow: { ...bot, id }, nodeName: 'Chat' });
    const first = await say('/chat-test/panel', { chatInput: 'one', sessionId: 's1' });
    expect(first.body).toEqual({ output: 'You said: one', sessionId: 's1' });
    expect(executions(t, id)[0]).toMatchObject({ mode: 'manual', status: 'success' });
    expect((await say('/chat-test/panel', { chatInput: 'two' })).status).toBe(404);
  });

  it('keeps chat paths apart from webhook and form paths, and refuses a duplicate chat path', async () => {
    const a = await createWorkflow(agent, echoBot('same'));
    const hook = await createWorkflow(agent, { name: 'Hook', nodes: [node('Webhook', 'webhook', { path: 'same' })], connections: {} });
    const b = await createWorkflow(agent, echoBot('same'));
    expect((await activate(agent, a)).status).toBe(200);
    expect((await activate(agent, hook)).status).toBe(200);
    const clash = await activate(agent, b);
    expect(clash.status).toBe(400);
    expect(clash.body.error.message).toMatch(/chat path "same".*already used/);
  });
});

describe('chatReply', () => {
  const items = (...json: object[]): Item[] => json.map((j) => ({ json: j as Item['json'] }));
  it('picks the reply field of the last node', () => {
    expect(chatReply(items({ output: 'a', text: 'b' }))).toBe('a');
    expect(chatReply(items({ text: 'from gemini', model: 'x' }))).toBe('from gemini');
    expect(chatReply(items({ answer: 42 }))).toBe('42');
    expect(chatReply(items({ only: 'one field' }))).toBe('one field');
    expect(chatReply(items({ output: { a: 1 } }))).toBe('{\n  "a": 1\n}');
    expect(chatReply(items({ a: 1, b: 2 }))).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(chatReply(items({ output: 'one' }, { output: 'two' }))).toBe('one\n\ntwo');
    expect(chatReply([])).toBe('The workflow finished without a reply.');
    expect(chatReply(items({ output: '  ' }, {}))).toBe('The workflow finished without a reply.');
  });
});

describe('chat memory', () => {
  it('stores turns per session, oldest first, bounded, and survives in SQLite', () => {
    const repo = t.ctx.chatMemory;
    repo.append('wf1:s1', [{ role: 'user', text: 'hi' }, { role: 'model', text: 'hello' }]);
    repo.append('wf1:s1', [{ role: 'user', text: 'how are you?' }]);
    repo.append('wf1:s2', [{ role: 'user', text: 'other session' }]);
    expect(repo.load('wf1:s1', 10)).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'model', text: 'hello' },
      { role: 'user', text: 'how are you?' },
    ]);
    expect(repo.load('wf1:s1', 2).map((m) => m.text)).toEqual(['hello', 'how are you?']);
    expect(repo.load('wf1:s1', 0)).toEqual([]);
    for (let i = 0; i < 230; i++) repo.append('wf1:big', [{ role: 'user', text: `m${i}` }]);
    expect(repo.count('wf1:big')).toBe(200);
    expect(repo.load('wf1:big', 1)[0]!.text).toBe('m229');
    repo.clear('wf1:s1');
    expect(repo.load('wf1:s1', 10)).toEqual([]);
    expect(repo.load('wf1:s2', 10)).toHaveLength(1);
  });
});

describe('Chat Trigger → Google Gemini with conversation memory', () => {
  let gemini: GeminiMock;
  beforeEach(async () => {
    gemini = await startGeminiMock();
  });
  afterEach(async () => {
    await gemini.close();
  });

  const texts = (call: { body?: unknown }) => (call.body as { contents: { role: string; parts: { text: string }[] }[] }).contents.map((c) => `${c.role}: ${c.parts[0]!.text}`);

  async function chatbot(path: string, memory: object = { memory: 'session' }) {
    await agent.post('/api/credentials').send({ name: 'Gemini', type: 'googlePalmApi', data: { apiKey: 'AIzaSy-test-key-000111222', host: gemini.url } });
    const id = await createWorkflow(agent, {
      name: 'Chatbot',
      nodes: [node('Chat', 'chatTrigger', { options: { path } }), node('Gemini', 'googleGemini', { prompt: '={{ $json.chatInput }}', systemInstruction: 'Be brief.', options: { maxRetries: 0 }, ...memory })],
      connections: chain('Chat', 'Gemini'),
    });
    expect((await activate(agent, id)).status).toBe(200);
    return id;
  }

  it('answers with the text of Gemini and remembers the session', async () => {
    const id = await chatbot('bot');
    gemini.enqueue(answer('Hello Ada!'), answer('Your name is Ada.'), answer('I do not know your name.'));
    const first = await say('/chat/bot', { chatInput: 'My name is Ada', sessionId: 'alice' });
    expect(first.body).toEqual({ output: 'Hello Ada!', sessionId: 'alice' });
    const second = await say('/chat/bot', { chatInput: 'What is my name?', sessionId: 'alice' });
    expect(second.body.output).toBe('Your name is Ada.');
    const other = await say('/chat/bot', { chatInput: 'What is my name?', sessionId: 'bob' });
    expect(other.body.output).toBe('I do not know your name.');

    expect(texts(gemini.calls[0]!)).toEqual(['user: My name is Ada']);
    expect(texts(gemini.calls[1]!)).toEqual(['user: My name is Ada', 'model: Hello Ada!', 'user: What is my name?']);
    expect(texts(gemini.calls[2]!)).toEqual(['user: What is my name?']);
    // Sessions are stored per workflow.
    expect(t.ctx.chatMemory.count(`${id}:alice`)).toBe(4);
    expect(t.ctx.chatMemory.count(`${id}:bob`)).toBe(2);
    expect(t.ctx.chatMemory.count('alice')).toBe(0);
  });

  it('sends only the last messages, always starting with a user message', async () => {
    const id = await chatbot('short', { memory: 'session', contextWindow: 3 });
    t.ctx.chatMemory.append(`${id}:s`, [
      { role: 'user', text: 'q1' },
      { role: 'model', text: 'a1' },
      { role: 'user', text: 'q2' },
      { role: 'model', text: 'a2' },
    ]);
    await say('/chat/short', { chatInput: 'q3', sessionId: 's' });
    // Window of 3 = a1, q2, a2: the leading model message is dropped.
    expect(texts(gemini.calls[0]!)).toEqual(['user: q2', 'model: a2', 'user: q3']);
  });

  it('remembers nothing when memory is off or when Gemini fails', async () => {
    const id = await chatbot('plain', { memory: 'none' });
    await say('/chat/plain', { chatInput: 'one', sessionId: 's' });
    await say('/chat/plain', { chatInput: 'two', sessionId: 's' });
    expect(texts(gemini.calls[1]!)).toEqual(['user: two']);
    expect(t.ctx.chatMemory.count(`${id}:s`)).toBe(0);

    const withMemory = await chatbot('mem');
    gemini.enqueue(apiError(400, 'Bad request for the test'));
    const failed = await say('/chat/mem', { chatInput: 'lost', sessionId: 's' });
    expect(failed.status).toBe(500);
    expect(failed.body.message).toBe('Sorry, something went wrong. Please try again in a moment.');
    expect(t.ctx.chatMemory.count(`${withMemory}:s`)).toBe(0);
  });
});
