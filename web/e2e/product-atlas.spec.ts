import { expect, test } from '@playwright/test';
import { runAndWait } from './helpers';

test('personal starter creates a real workflow and produces a personalised message', async ({ page }, info) => {
  await page.goto('/home');
  await expect(page.getByRole('heading', { name: 'Tableau de bord', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('atlas-dashboard.png'), fullPage: true });
  await page.getByTestId('create-starter').click();
  await expect(page).toHaveURL(/\/workflow\//);
  await expect(page.getByTestId('workflow-name')).toHaveText('Mon premier flow Atlas');
  const id = page.url().split('/').at(-1)!;
  await runAndWait(page);
  await page.goto(`/executions?workflowId=${id}`);
  await page.getByTestId('execution-row').first().getByTestId('execution-status-badge').click();
  await expect(page).toHaveURL(/\/executions\/\d+$/);
  await page.locator('[data-testid="execution-node"][data-node="Mon message"]').click();
  await expect(page.getByTestId('execution-output')).toContainText('Bonjour Grace, bienvenue dans Atlas Flow !');
  await page.screenshot({ path: info.outputPath('atlas-result.png'), fullPage: true });
});

test('favorites persist after reload, combine with search and disappear when unstarred', async ({ page }) => {
  const first = await page.request.post('/api/workflows', { data: { name: 'Atlas favori' } });
  const second = await page.request.post('/api/workflows', { data: { name: 'Atlas autre' } });
  const ids = [(await first.json()).id, (await second.json()).id];
  try {
    await page.goto('/workflows');
    const row = page.locator('[data-testid="workflow-row"][data-name="Atlas favori"]');
    await row.getByTestId('workflow-favorite').click();
    await expect(row.getByTestId('workflow-favorite')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('favorites-filter').click();
    await expect(page).toHaveURL(/favorites=1/);
    await page.reload();
    await expect(row).toBeVisible();
    await expect(page.locator('[data-testid="workflow-row"][data-name="Atlas autre"]')).toHaveCount(0);
    await page.getByTestId('workflow-search').fill('aucun résultat');
    await expect(page.getByTestId('no-results')).toBeVisible();
    await page.getByTestId('workflow-search').fill('');
    await row.getByTestId('workflow-favorite').click();
    await expect(row).toHaveCount(0);
    await page.getByTestId('clear-filters').click();
    await expect(row).toBeVisible();
  } finally {
    for (const id of ids) await page.request.delete(`/api/workflows/${id}`);
  }
});

test('guide searches without accents, shows an empty state and links to the right page', async ({ page }) => {
  await page.goto('/guide');
  const search = page.getByRole('textbox', { name: 'Rechercher dans le guide' });
  await search.fill('meteo');
  await expect(page.getByRole('heading', { name: 'Météo et fichiers' })).toBeVisible();
  await search.fill('zzzzzzzz');
  await expect(page.getByText('Aucun résultat. Essaie un autre mot, ou efface la recherche.')).toBeVisible();
  await search.fill('Favoris');
  await page.getByRole('link', { name: 'Ouvrir', exact: true }).click();
  await expect(page).toHaveURL('/workflows?favorites=1');
});

test('dashboard, workflows and guide fit a phone viewport', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/home', '/workflows', '/guide']) {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ouvrir le menu' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`atlas-mobile-${path.slice(1)}.png`), fullPage: true });
  }
});
