import { expect, test } from '@playwright/test';

test('workflows list: tag, search and duplicate', async ({ page }) => {
  const names = ['P7 Alpha report', 'P7 Beta sync'];
  for (const name of names) expect((await page.request.post('/api/workflows', { data: { name } })).ok()).toBe(true);
  await page.goto('/workflows');
  const row = (name: string) => page.locator(`[data-testid="workflow-row"][data-name="${name}"]`);
  await expect(row('P7 Alpha report')).toBeVisible();

  // Tag the first workflow (creates the tag from the picker).
  await row('P7 Alpha report').getByTestId('workflow-tags-edit').click();
  await page.getByTestId('tag-picker-input').fill('p7-urgent');
  await page.getByTestId('tag-picker-add').click();
  await expect(page.locator('[data-testid="tag-option"][data-name="p7-urgent"]')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('tag-picker-done').click();
  await expect(row('P7 Alpha report').getByTestId('workflow-tag')).toHaveText('p7-urgent');

  // Filter by the tag chip, then by search.
  await page.locator('[data-testid="tag-chip"][data-name="p7-urgent"]').click();
  await expect(row('P7 Alpha report')).toBeVisible();
  await expect(row('P7 Beta sync')).toHaveCount(0);
  await expect(page).toHaveURL(/tags=/);
  await page.getByTestId('clear-filters').click();
  await page.getByTestId('workflow-search').fill('beta');
  await expect(row('P7 Beta sync')).toBeVisible();
  await expect(row('P7 Alpha report')).toHaveCount(0);
  await page.getByTestId('workflow-search').fill('p7-urg'); // search also matches tag names
  await expect(row('P7 Alpha report')).toBeVisible();
  await page.getByTestId('workflow-search').fill('');

  // Duplicate keeps the tag.
  await row('P7 Alpha report').getByTestId('workflow-duplicate').click();
  await expect(row('P7 Alpha report (copy)')).toBeVisible();
  await expect(row('P7 Alpha report (copy)').getByTestId('workflow-tag')).toHaveText('p7-urgent');

  // Bulk delete the two copies of the test data.
  await row('P7 Alpha report (copy)').getByTestId('workflow-select').check();
  await row('P7 Beta sync').getByTestId('workflow-select').check();
  await page.getByTestId('bulk-delete').click();
  await page.getByTestId('confirm-ok').click();
  await expect(row('P7 Beta sync')).toHaveCount(0);
  await expect(row('P7 Alpha report (copy)')).toHaveCount(0);
  await expect(row('P7 Alpha report')).toBeVisible();
});
