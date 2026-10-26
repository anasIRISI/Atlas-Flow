import { expect, test } from '@playwright/test';
import { canvasNode, canvasNodes, closePanel, expectStatus, fourNodeWorkflow, openNewWorkflow, runAndWait } from './helpers';

test('4) execute step runs only up to the chosen node', async ({ page }) => {
  await openNewWorkflow(page, fourNodeWorkflow('E2E step'));
  await canvasNode(page, 'If').dblclick();
  await page.getByTestId('ndv-execute-step').click();
  await expect(page.getByTestId('output-panel')).toContainText('42');
  await expect(page.getByTestId('output-tab-0')).toContainText('(1)');
  await expect(page.getByTestId('input-panel')).toContainText('from Edit Fields');
  await closePanel(page);
  await expectStatus(page, 'Start', 'success');
  await expectStatus(page, 'Edit Fields', 'success');
  await expectStatus(page, 'If', 'success');
  await expectStatus(page, 'Result', 'idle');
  await expect(page.getByTestId('execution-log')).toContainText('step "If"');
});

test('5) pinned data is used instead of running the node', async ({ page }) => {
  await openNewWorkflow(page, fourNodeWorkflow('E2E pin'));
  await runAndWait(page);
  await expectStatus(page, 'Result', 'success');

  // Pin the output of "Edit Fields" (age 42)…
  await canvasNode(page, 'Edit Fields').dblclick();
  await page.getByTestId('pin-data').click();
  await expect(page.getByTestId('pinned-banner')).toBeVisible();
  // …then change age to 10: without the pin, If would now be false.
  await page.getByTestId('param-assignments-0-value-input').fill('10');
  await closePanel(page);
  await expect(canvasNode(page, 'Edit Fields').getByTestId('node-pinned')).toBeVisible();

  await runAndWait(page);
  await expectStatus(page, 'Edit Fields', 'pinned');
  await expectStatus(page, 'Result', 'success');

  // Unpin: the real value (10) is used and the If sends nothing to Result.
  await canvasNode(page, 'Edit Fields').dblclick();
  await page.getByTestId('unpin-data').click();
  await closePanel(page);
  await expect(canvasNode(page, 'Edit Fields').getByTestId('node-pinned')).toHaveCount(0);
  await runAndWait(page);
  await expectStatus(page, 'Edit Fields', 'success');
  await expectStatus(page, 'Result', 'idle');
});

test('6) Ctrl+K palette opens and adds a node', async ({ page }) => {
  await openNewWorkflow(page, fourNodeWorkflow('E2E palette'));
  await expect(canvasNodes(page)).toHaveCount(4);
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('command-palette-input').fill('No Operation');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect(canvasNodes(page)).toHaveCount(5);
  await expect(canvasNode(page, 'No Operation, do nothing')).toBeVisible();
});

test('shortcuts help dialog and node error card', async ({ page }) => {
  const wf = fourNodeWorkflow('E2E error');
  (wf.nodes as Array<Record<string, unknown>>)[2] = {
    ...(wf.nodes as Array<Record<string, unknown>>)[2],
    parameters: {
      conditions: {
        conditions: [{ id: 'c1', leftValue: '={{ $json.age.nope.deeper }}', rightValue: 1, operator: { type: 'number', operation: 'gt' } }],
        combinator: 'and',
      },
    },
  };
  await openNewWorkflow(page, wf);
  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0);

  await runAndWait(page, 'error');
  await expectStatus(page, 'If', 'error');
  await expect(page.getByTestId('toast-error')).toContainText('Problem in node "If"');
  await canvasNode(page, 'If').dblclick();
  await expect(page.getByTestId('node-error')).toContainText('Cannot read properties of undefined');
  await expect(page.getByTestId('node-error')).toContainText('optional chaining');
});
