import { expect, test } from '@playwright/test';
import { canvasNode, canvasNodes, closePanel, edges, fourNodeWorkflow, openNewWorkflow } from './helpers';

test('2) save, reload and get the same workflow back', async ({ page }) => {
  const id = await openNewWorkflow(page, fourNodeWorkflow('E2E save'));
  await expect(canvasNodes(page)).toHaveCount(4);

  // Rename the workflow and change a parameter.
  await page.getByTestId('workflow-name').click();
  await page.getByTestId('workflow-name-input').fill('E2E saved and reloaded');
  await page.getByTestId('workflow-name-input').press('Enter');
  await canvasNode(page, 'Result').dblclick();
  await page.getByTestId('param-assignments-0-value-input').fill('changed value');
  await closePanel(page);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-dirty', 'true');

  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-dirty', 'false');

  await page.reload();
  await expect(page.getByTestId('workflow-name')).toHaveText('E2E saved and reloaded');
  await expect(canvasNodes(page)).toHaveCount(4);
  await expect(edges(page)).toHaveCount(3);
  await canvasNode(page, 'Result').dblclick();
  await expect(page.getByTestId('param-assignments-0-value-input')).toHaveValue('changed value');
  await closePanel(page);

  // It is in the workflows list.
  await page.goto('/workflows');
  await expect(page.locator(`[data-testid="workflow-row"][data-name="E2E saved and reloaded"]`)).toBeVisible();
  expect(id).toBeTruthy();
});

test('unsaved changes: leaving asks for confirmation', async ({ page }) => {
  await openNewWorkflow(page, fourNodeWorkflow('E2E unsaved'));
  await canvasNode(page, 'Result').click();
  await page.keyboard.press('d'); // disable → unsaved change
  await expect(canvasNode(page, 'Result')).toHaveAttribute('data-disabled', 'true');
  await page.getByRole('link', { name: 'Workflows' }).click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-cancel').click();
  await expect(page).toHaveURL(/\/workflow\//);
  await page.getByRole('link', { name: 'Workflows' }).click();
  await page.getByTestId('confirm-ok').click();
  await expect(page).toHaveURL(/\/workflows$/);
});

test('3) undo / redo every canvas change, copy / paste keeps connections', async ({ page }) => {
  await openNewWorkflow(page, fourNodeWorkflow('E2E undo'));
  await expect(canvasNodes(page)).toHaveCount(4);

  // Delete a node (and its edges), then undo / redo.
  await canvasNode(page, 'If').click();
  await page.keyboard.press('Delete');
  await expect(canvasNodes(page)).toHaveCount(3);
  await expect(edges(page)).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(canvasNodes(page)).toHaveCount(4);
  await expect(edges(page)).toHaveCount(3);
  await page.keyboard.press('Control+Shift+z');
  await expect(canvasNodes(page)).toHaveCount(3);
  await page.keyboard.press('Control+z');
  await expect(canvasNodes(page)).toHaveCount(4);

  // Copy everything and paste: nodes and the connections between them are duplicated.
  await page.locator('.react-flow__pane').click({ position: { x: 200, y: 200 } });
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await expect(canvasNodes(page)).toHaveCount(8);
  await expect(edges(page)).toHaveCount(6);
  await expect(canvasNode(page, 'Start1')).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(canvasNodes(page)).toHaveCount(4);

  // Duplicate one node.
  await canvasNode(page, 'Result').click();
  await page.keyboard.press('Control+d');
  await expect(canvasNode(page, 'Result1')).toBeVisible();
  await page.keyboard.press('Control+z');
  await expect(canvasNode(page, 'Result1')).toHaveCount(0);
});
