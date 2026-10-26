import { expect, test } from '@playwright/test';
import { addNode, canvasNode, canvasNodes, closePanel, edges, expectStatus, runAndWait } from './helpers';

test('1) build Manual → Edit Fields → If → Edit Fields in the editor, run it, check statuses and output', async ({ page }) => {
  await page.goto('/workflows');
  await page.getByTestId('create-workflow').click();
  await expect(page).toHaveURL(/\/workflow\//);

  // Empty canvas: add the trigger.
  await page.getByTestId('canvas-add-first-step').click();
  await expect(page.getByTestId('node-creator')).toContainText('What triggers this workflow?');
  await page.getByTestId('node-creator-search').fill('manual');
  await page.getByTestId('creator-item-flowforge.manualTrigger').click();
  await expect(canvasNodes(page)).toHaveCount(1);
  await expect(page.getByTestId('ndv')).toHaveCount(0); // triggers do not open the panel

  // Edit Fields: auto-connected to the selected trigger, panel opens.
  await addNode(page, 'edit fields', 'flowforge.set');
  await expect(page.getByTestId('ndv')).toBeVisible();
  await page.getByTestId('param-assignments-add').click();
  await page.getByTestId('param-assignments-0-name').fill('age');
  await page.getByTestId('param-assignments-0-type').selectOption('number');
  await page.getByTestId('param-assignments-0-value-input').fill('42');
  await closePanel(page);

  // If: left value as an expression via the fx toggle.
  await addNode(page, 'if', 'flowforge.if');
  await page.getByTestId('param-conditions-0-left-toggle').click();
  await page.getByTestId('param-conditions-0-left-editor').locator('.cm-content').fill('{{ $json.age }}');
  await page.getByTestId('param-conditions-0-operator').selectOption('number:gt');
  await page.getByTestId('param-conditions-0-right').locator('input').fill('40');
  await closePanel(page);

  // Second Edit Fields on the "true" output.
  await addNode(page, 'edit fields', 'flowforge.set');
  await page.getByTestId('param-includeOtherFields').getByRole('switch').click();
  await page.getByTestId('param-assignments-add').click();
  await page.getByTestId('param-assignments-0-name').fill('result');
  await page.getByTestId('param-assignments-0-value-input').fill('old enough');
  await closePanel(page);

  await expect(canvasNodes(page)).toHaveCount(4);
  await expect(edges(page)).toHaveCount(3);

  await runAndWait(page);
  for (const name of ['When clicking "Execute workflow"', 'Edit Fields', 'If', 'Edit Fields1']) await expectStatus(page, name, 'success');
  await expect(canvasNode(page, 'If').getByTestId('node-item-count')).toHaveText('1 item');
  await expect(page.getByTestId('edge-count')).toHaveCount(3);
  await expect(page.getByTestId('log-row')).toHaveCount(4);

  // Output of the last node.
  await canvasNode(page, 'Edit Fields1').dblclick();
  await expect(page.getByTestId('output-panel')).toContainText('old enough');
  await expect(page.getByTestId('output-panel')).toContainText('42');
  await expect(page.getByTestId('input-panel')).toContainText('from If');
});

test('live view: a running node glows, then turns green', async ({ page }) => {
  const res = await page.request.post('/api/workflows', {
    data: {
      name: 'E2E slow',
      nodes: [
        { id: 'a', name: 'Start', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        {
          id: 'b',
          name: 'Busy',
          type: 'flowforge.code',
          typeVersion: 1,
          position: [240, 0],
          parameters: { jsCode: 'const end = Date.now() + 1500;\nwhile (Date.now() < end) {}\nreturn [{ json: { done: true } }];' },
        },
      ],
      connections: { Start: { main: [[{ node: 'Busy', type: 'main', index: 0 }]] } },
    },
  });
  const { id } = await res.json();
  await page.goto(`/workflow/${id}`);
  await page.getByTestId('execute-workflow').click();
  await expect(canvasNode(page, 'Busy')).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('stop-execution')).toBeVisible();
  await expect(canvasNode(page, 'Busy')).toHaveAttribute('data-status', 'success', { timeout: 10_000 });
  await expect(page.getByTestId('execute-workflow')).toBeVisible();
});
