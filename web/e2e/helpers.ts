import { expect, type Page } from '@playwright/test';

type Json = Record<string, unknown>;

const conn = (node: string, index = 0) => ({ node, type: 'main', index });

/** Manual → Edit Fields (age=42) → If (age > 40) → Result (true branch). */
export function fourNodeWorkflow(name = 'E2E four nodes'): Json {
  return {
    name,
    nodes: [
      { id: 'n1', name: 'Start', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: 'n2',
        name: 'Edit Fields',
        type: 'flowforge.set',
        typeVersion: 1,
        position: [240, 0],
        parameters: { assignments: { assignments: [{ id: 'a1', name: 'age', value: 42, type: 'number' }] } },
      },
      {
        id: 'n3',
        name: 'If',
        type: 'flowforge.if',
        typeVersion: 1,
        position: [480, 0],
        parameters: {
          conditions: {
            conditions: [{ id: 'c1', leftValue: '={{ $json.age }}', rightValue: 40, operator: { type: 'number', operation: 'gt' } }],
            combinator: 'and',
          },
        },
      },
      {
        id: 'n4',
        name: 'Result',
        type: 'flowforge.set',
        typeVersion: 1,
        position: [720, 0],
        parameters: { includeOtherFields: true, assignments: { assignments: [{ id: 'a2', name: 'result', value: 'old enough', type: 'string' }] } },
      },
    ],
    connections: {
      Start: { main: [[conn('Edit Fields')]] },
      'Edit Fields': { main: [[conn('If')]] },
      If: { main: [[conn('Result')]] },
    },
  };
}

/** Creates a workflow through the API and opens it in the editor. */
export async function openNewWorkflow(page: Page, body: Json): Promise<string> {
  const res = await page.request.post('/api/workflows', { data: body });
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/workflow/${id}`);
  await expect(page.getByTestId('workflow-name')).toBeVisible();
  return id;
}

// JSON.stringify gives a valid CSS string even when the name contains quotes.
export const canvasNode = (page: Page, name: string) => page.locator(`[data-testid="canvas-node"][data-node-name=${JSON.stringify(name)}]`);
export const canvasNodes = (page: Page) => page.getByTestId('canvas-node');
export const edges = (page: Page) => page.locator('.react-flow__edge');

export async function expectStatus(page: Page, name: string, status: string) {
  await expect(canvasNode(page, name)).toHaveAttribute('data-status', status);
}

export async function runAndWait(page: Page, status = 'success') {
  await page.getByTestId('execute-workflow').click();
  await expect(page.getByTestId('execution-status')).toHaveAttribute('data-status', status, { timeout: 15_000 });
}

/** Opens the node creator, searches and clicks the node type. */
export async function addNode(page: Page, query: string, type: string) {
  await page.getByTestId('open-node-creator').click();
  await page.getByTestId('node-creator-search').fill(query);
  await page.getByTestId(`creator-item-${type}`).click();
}

export async function closePanel(page: Page) {
  await page.getByTestId('ndv-close').click();
  await expect(page.getByTestId('ndv')).toHaveCount(0);
}
