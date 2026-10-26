import { expect, test } from '@playwright/test';

// Demo Mode end to end with no API keys: offline/showcase workflow, QR code, simulated submission, SIMULATED badges.
test('Demo Mode runs the whole script without any key and shows the results card', async ({ page }) => {
  test.setTimeout(150_000);
  // ?demoWait=… makes the "wait for a real submission" step short for the test.
  await page.goto('/?demoWait=800');
  await page.getByTestId('demo-mode-button').click();

  const overlay = page.getByTestId('demo-overlay');
  await expect(overlay).toBeVisible({ timeout: 60_000 });
  await expect(page).toHaveURL(/\/workflow\/.+demo=1/);
  await expect(page.getByTestId('demo-step')).toContainText('/ 5');

  // The form's QR code appears (step 2).
  await expect(page.getByTestId('qr-dialog')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('qr-url')).toContainText('/form-test/');
  await page.getByTestId('qr-close').click();

  // Nobody submits: Demo Mode simulates a submission and runs the workflow.
  await expect(page.getByTestId('demo-simulating')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('demo-results')).toBeVisible({ timeout: 90_000 });
  await expect(overlay).toHaveAttribute('data-step', '5');

  // No Telegram / Discord keys: those are simulated and the canvas shows the orange badge. (Email may be really
  // sent: an earlier spec leaves a default SMTP credential pointing at a local test server.)
  for (const name of ['Telegram', 'Discord']) {
    await expect(page.locator('[data-testid="demo-result"][data-status="simulated"]').filter({ hasText: name })).toHaveCount(1);
  }
  await expect(page.getByTestId('node-simulated').first()).toBeVisible();
  expect(await page.getByTestId('node-simulated').count()).toBeGreaterThanOrEqual(2);

  await page.getByTestId('demo-stop').click();
  await expect(overlay).toBeHidden();
});
