import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { expectStatus, openNewWorkflow } from './helpers';

interface GeminiCall {
  key: string;
  contents: { role: string; parts: { text: string }[] }[];
}

/** Stands in for the Gemini API: answers with what it was asked and how many messages came along. */
async function startMockGemini(): Promise<{ url: string; calls: GeminiCall[]; close(): Promise<void> }> {
  const calls: GeminiCall[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { contents?: GeminiCall['contents'] };
      const contents = body.contents ?? [];
      calls.push({ key: String(req.headers['x-goog-api-key'] ?? ''), contents });
      const question = contents[contents.length - 1]?.parts[0]?.text ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: `Mock Gemini heard "${question}" (${contents.length} messages)` }] }, finishReason: 'STOP' }], modelVersion: 'gemini-3.8-flash' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test('Chat Trigger → Gemini: test chat in the editor, then the hosted chat page on a phone', async ({ page }) => {
  const gemini = await startMockGemini();
  // Created by this test and removed at the end: other specs expect an empty Credentials page.
  let credentialId = '';
  let workflowId = '';
  try {
    const credential = await page.request.post('/api/credentials', { data: { name: 'E2E Gemini', type: 'googlePalmApi', data: { apiKey: 'AIzaSy-e2e-key-0123456789', host: gemini.url } } });
    expect(credential.status()).toBe(201);
    credentialId = ((await credential.json()) as { id: string }).id;
    const id = await openNewWorkflow(page, {
      name: 'E2E chatbot',
      nodes: [
        { id: 'c', name: 'Chat', type: 'flowforge.chatTrigger', typeVersion: 1, position: [0, 0], parameters: { title: 'E2E assistant', initialMessages: 'Hello from the bot', options: { path: 'e2e-chat' } } },
        {
          id: 'g',
          name: 'Gemini',
          type: 'flowforge.googleGemini',
          typeVersion: 1,
          position: [260, 0],
          parameters: { prompt: '={{ $json.chatInput }}', memory: 'session', options: { maxRetries: 0 } },
          credentials: { googlePalmApi: { id: credentialId, name: 'E2E Gemini' } },
        },
      ],
      connections: { Chat: { main: [[{ node: 'Gemini', type: 'main', index: 0 }]] } },
    });

    workflowId = id;

    // 1. In the editor: the Chat button opens the test chat; each message runs the workflow live.
    await page.getByTestId('chat-open').click();
    await page.getByTestId('chat-input').fill('Hi from the editor');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-message-user')).toHaveText('Hi from the editor');
    await expect(page.getByTestId('chat-message-bot')).toHaveText('Mock Gemini heard "Hi from the editor" (1 messages)');
    await expectStatus(page, 'Chat', 'success');
    await expectStatus(page, 'Gemini', 'success');
    // Second message of the same session: the conversation is remembered (question + answer + new question).
    await page.getByTestId('chat-input').fill('And again');
    await page.getByTestId('chat-input').press('Enter');
    await expect(page.getByTestId('chat-message-bot').nth(1)).toHaveText('Mock Gemini heard "And again" (3 messages)');
    expect(gemini.calls[0]!.key).toBe('AIzaSy-e2e-key-0123456789');

    // 2. Active workflow: the public chat page, on a phone-sized screen, without login.
    expect((await page.request.post(`/api/workflows/${id}/activate`, { data: {} })).status()).toBe(200);
    const phone = await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const chat = await phone.newPage();
    await chat.goto(new URL('/chat/e2e-chat', page.url()).toString());
    await expect(chat.locator('header h1')).toHaveText('E2E assistant');
    await expect(chat.locator('.msg.bot').first()).toHaveText('Hello from the bot');
    await chat.locator('#q').fill('What is the weather?');
    await chat.locator('#send').click();
    await expect(chat.locator('.msg.user')).toHaveText('What is the weather?');
    await expect(chat.locator('.msg.bot').nth(1)).toHaveText('Mock Gemini heard "What is the weather?" (1 messages)');
    // The page fits the phone (no horizontal scrolling) and keeps the conversation after a reload.
    expect(await chat.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await chat.reload();
    await expect(chat.locator('.msg.bot').nth(1)).toHaveText('Mock Gemini heard "What is the weather?" (1 messages)');
    await chat.locator('#q').fill('Second question');
    await chat.locator('#q').press('Enter');
    await expect(chat.locator('.msg.bot').nth(2)).toHaveText('Mock Gemini heard "Second question" (3 messages)');
    // "New chat" starts a fresh session.
    await chat.locator('#new').click();
    await expect(chat.locator('.msg')).toHaveCount(1);
    await phone.close();
  } finally {
    if (workflowId) await page.request.post(`/api/workflows/${workflowId}/deactivate`, { data: {} });
    if (credentialId) await page.request.delete(`/api/credentials/${credentialId}`);
    await gemini.close();
  }
});
