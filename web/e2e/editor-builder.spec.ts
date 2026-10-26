import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { canvasNode, canvasNodes, edges, expectStatus, openNewWorkflow, runAndWait } from './helpers';

/** What the mock "Gemini" designs for the builder: a trigger, an agent and its chat model. */
const DESIGN = {
  name: 'Greeter agent',
  nodes: [
    { name: 'Start', type: 'flowforge.manualTrigger', parameters: {} },
    { name: 'Agent', type: 'flowforge.aiAgent', parameters: { prompt: 'Say hello to the class' } },
    { name: 'Model', type: 'flowforge.geminiChatModel', parameters: {} },
  ],
  connections: [
    { from: 'Start', to: 'Agent' },
    { from: 'Model', to: 'Agent', type: 'ai_languageModel' },
  ],
  notes: ['Click Execute workflow to hear the agent.'],
};

interface Call {
  json: boolean;
  text: string;
}

/** Stands in for Gemini: a JSON-mode request is the builder, anything else is the agent talking. */
async function startMockGemini(): Promise<{ url: string; calls: Call[]; close(): Promise<void> }> {
  const calls: Call[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(raw || '{}') as { generationConfig?: { responseMimeType?: string } };
      const json = body.generationConfig?.responseMimeType === 'application/json';
      calls.push({ json, text: raw });
      const text = json ? JSON.stringify(DESIGN) : 'Hello class, I am the mock agent!';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], modelVersion: 'gemini-3.8-flash' }));
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

test('AI Workflow Builder: a prompt becomes nodes that appear on the canvas, and the workflow runs', async ({ page }) => {
  const gemini = await startMockGemini();
  let credentialId = '';
  try {
    const credential = await page.request.post('/api/credentials', { data: { name: 'E2E builder Gemini', type: 'googlePalmApi', data: { apiKey: 'AIzaSy-e2e-builder-key-01', host: gemini.url } } });
    expect(credential.status()).toBe(201);
    credentialId = ((await credential.json()) as { id: string }).id;

    await openNewWorkflow(page, { name: 'E2E builder', nodes: [], connections: {} });
    // Empty canvas: the prompt bar and its six suggestions are there.
    await expect(page.getByTestId('builder-bar')).toBeVisible();
    await expect(page.getByTestId('builder-chip')).toHaveCount(6);
    await expect(canvasNodes(page)).toHaveCount(0);

    await page.getByTestId('builder-input').fill('An agent that greets my class');
    await page.getByTestId('builder-submit').click();

    // Nodes are drawn one after the other, then the result is labelled.
    await expect(canvasNodes(page)).toHaveCount(3);
    await expect(page.getByTestId('builder-label')).toHaveText('Built with Gemini');
    await expect(page.getByTestId('builder-label')).toHaveAttribute('data-source', 'ai');
    await expect(page.getByTestId('builder-result')).toContainText('Click Execute workflow to hear the agent.');
    await expect(page.getByTestId('workflow-name')).toHaveText('Greeter agent');
    // The chat model is a sub-node plugged into the agent (one data connection + one slot connection).
    await expect(canvasNode(page, 'Model')).toHaveAttribute('data-sub-node', 'ai_languageModel');
    await expect(edges(page)).toHaveCount(2);
    // The credential exists, so no node asks for one.
    await expect(page.getByTestId('node-missing-credential')).toHaveCount(0);
    // The request to "Gemini" held the user's text and the node catalog, never the key.
    const design = gemini.calls.find((c) => c.json)!;
    expect(design.text).toContain('An agent that greets my class');
    expect(design.text).toContain('flowforge.aiAgent');
    expect(design.text).not.toContain('AIzaSy-e2e-builder-key-01');

    // The built workflow is valid: it runs, and the agent answers through its chat model.
    await runAndWait(page);
    await expectStatus(page, 'Agent', 'success');
    await expectStatus(page, 'Model', 'success');
    await canvasNode(page, 'Agent').dblclick();
    await expect(page.getByTestId('output-panel')).toContainText('Hello class, I am the mock agent!');
  } finally {
    if (credentialId) await page.request.delete(`/api/credentials/${credentialId}`);
    await gemini.close();
  }
});
