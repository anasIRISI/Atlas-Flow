import { expect, test } from '@playwright/test';
import { fourNodeWorkflow, openNewWorkflow, runAndWait } from './helpers';

test('run a workflow, find it in Executions, see per-node data, colours survive a reload', async ({ page }) => {
  const id = await openNewWorkflow(page, fourNodeWorkflow('E2E executions'));
  await runAndWait(page);

  await page.goto(`/executions?workflowId=${id}`);
  const row = page.getByTestId('execution-row').first();
  await expect(row).toBeVisible();
  await expect(row.getByTestId('execution-status-badge')).toHaveAttribute('data-status', 'success');
  await row.click();

  await expect(page).toHaveURL(/\/executions\/\d+/);
  await expect(page.getByTestId('execution-node')).toHaveCount(4);
  await page.locator('[data-testid="execution-node"][data-node="Edit Fields"]').click();
  await expect(page.getByTestId('execution-output')).toContainText('42');
  await expect(page.getByTestId('execution-input-count')).toHaveText('1 item');

  // Editor restore: colours and outputs come back after a reload.
  await page.getByTestId('open-in-editor').click();
  await expect(page.getByTestId('workflow-name')).toBeVisible();
  await expect(page.locator('[data-testid="canvas-node"][data-node-name="If"]')).toHaveAttribute('data-status', 'success');
  await page.reload();
  await expect(page.locator('[data-testid="canvas-node"][data-node-name="Edit Fields"]')).toHaveAttribute('data-status', 'success');
});
