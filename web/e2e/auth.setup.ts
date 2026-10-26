import { expect, test as setup } from '@playwright/test';
import { STORAGE_STATE } from '../playwright.config';

// The owner account was created by the phase0 tests on the fresh install.
setup('sign in once for the editor tests', async ({ page }) => {
  const res = await page.request.post('/api/auth/login', { data: { email: 'teacher@school.edu', password: 'Forge2026' } });
  expect(res.ok()).toBe(true);
  await page.context().storageState({ path: STORAGE_STATE });
});
