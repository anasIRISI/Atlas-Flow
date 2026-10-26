import { expect, test } from '@playwright/test';
import { fourNodeWorkflow, openNewWorkflow, runAndWait, expectStatus } from './helpers';

test('time travel: step through a finished execution, then leave replay', async ({ page }) => {
  await openNewWorkflow(page, fourNodeWorkflow('E2E time travel'));
  await runAndWait(page);

  await page.getByTestId('log-time-travel').click();
  await expect(page).toHaveURL(/replay=1/);
  await expect(page.getByTestId('timetravel-bar')).toBeVisible();
  await expect(page.getByTestId('tt-tick')).toHaveCount(4);

  // Step 1: only the trigger had run.
  await expect(page.getByTestId('tt-label')).toContainText('Step 1 / 4');
  await expectStatus(page, 'Start', 'success');
  await expectStatus(page, 'Edit Fields', 'idle');
  await expectStatus(page, 'Result', 'idle');

  // Step 2: Edit Fields output has age = 42, its input is the trigger item.
  await page.getByTestId('tt-next').click();
  await expect(page.getByTestId('tt-label')).toContainText('Step 2 / 4');
  await expect(page.getByTestId('tt-label')).toContainText('Edit Fields');
  await expectStatus(page, 'Edit Fields', 'success');
  await expectStatus(page, 'If', 'idle');
  await expect(page.getByTestId('tt-output')).toContainText('42');
  await expect(page.getByTestId('tt-input')).toHaveAttribute('data-count', '1');

  // Keyboard: right arrow forward, left arrow back.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('tt-label')).toContainText('Step 3 / 4');
  await expectStatus(page, 'If', 'success');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('tt-label')).toContainText('Step 2 / 4');
  await expectStatus(page, 'If', 'idle');

  // Scrubber jump to the end.
  await page.getByTestId('tt-tick').nth(3).click();
  await expect(page.getByTestId('tt-label')).toContainText('Step 4 / 4');
  await expectStatus(page, 'Result', 'success');
  await expect(page.getByTestId('tt-output')).toContainText('old enough');

  // Exit: the normal finished view comes back and the bar is gone.
  await page.getByTestId('tt-exit').click();
  await expect(page.getByTestId('timetravel-bar')).toHaveCount(0);
  await expect(page).not.toHaveURL(/replay=1/);
  await expectStatus(page, 'Result', 'success');
  await expect(page.getByTestId('execution-status')).toHaveAttribute('data-status', 'success');
});
