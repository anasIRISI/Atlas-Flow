import { expect, test } from '@playwright/test';

const OWNER = { email: 'teacher@school.edu', first: 'Grace', last: 'Hopper', password: 'Forge2026' };

// One serial story: fresh install → owner setup → shell → sign out → sign in.
test.describe.configure({ mode: 'serial' });

test('fresh install redirects to owner setup and validates the form', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Créer mon espace' })).toBeVisible();

  // Sign-in is not reachable before setup.
  await page.goto('/signin');
  await expect(page).toHaveURL(/\/setup$/);

  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByText('Saisis une adresse email valide')).toBeVisible();
  await expect(page.getByText('Le prénom est obligatoire')).toBeVisible();
  const rules = page.getByRole('list', { name: 'Password rules' });
  await expect(rules.locator('li.text-danger')).toHaveCount(3);

  // Errors clear live as the user fixes them; nothing was submitted to the server.
  await page.getByLabel('Email').fill('teacher@school.edu');
  await expect(page.getByText('Saisis une adresse email valide')).toHaveCount(0);
  await page.getByLabel('Mot de passe', { exact: true }).fill('forge1');
  await expect(rules.locator('li.text-success')).toHaveCount(1);
  await page.getByLabel('Mot de passe', { exact: true }).fill(OWNER.password);
  await expect(rules.locator('li.text-success')).toHaveCount(3);
  await expect(page).toHaveURL(/\/setup$/);
});

test('owner setup signs in and shows the app shell with a live connection', async ({ page }) => {
  await page.goto('/setup');
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Prénom').fill(OWNER.first);
  await page.getByLabel('Nom', { exact: true }).fill(OWNER.last);
  await page.getByLabel('Mot de passe', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Créer mon compte' }).click();

  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();
  await expect(page.getByText(`Bonjour ${OWNER.first}.`)).toBeVisible();
  await expect(page.getByTestId('user-name')).toHaveText(`${OWNER.first} ${OWNER.last}`);
  await expect(page.getByTestId('server-status')).toContainText('En marche');
  await expect(page.getByTestId('ws-status')).toHaveAttribute('data-status', 'open');
  await expect(page.getByTestId('public-url')).toContainText('http://');

  // Every sidebar entry opens a page.
  for (const [label, heading] of [
    ['Mes workflows', 'Mes workflows'],
    ['Modèles', 'La bonne idée, déjà prête.'],
    ['Historique', 'Historique des exécutions'],
    ['Connexions', 'Mes connexions'],
    ['Variables', 'Variables'],
    ['Paramètres', 'Paramètres'],
  ]) {
    await page.locator('aside').getByRole('link', { name: label, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
  // Every page is real now (no "Phase N" placeholders left).
  await page.locator('aside').getByRole('link', { name: 'Connexions', exact: true }).click();
  await expect(page.getByTestId('create-credential')).toBeVisible();
  await expect(page.getByText(/Phase \d/)).toHaveCount(0);

  // Unknown pages show a 404 inside the shell.
  await page.goto('/does-not-exist');
  await expect(page.getByText('Page not found')).toBeVisible();

  // Session survives a reload; the sidebar collapse state is remembered.
  await page.getByRole('button', { name: 'Réduire le menu' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Ouvrir le menu' })).toBeVisible();
  await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
});

test('sign out, wrong password, sign in with redirect back', async ({ page }) => {
  await page.goto('/home');
  // Previous test's cookies are not shared, so we start signed out.
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole('heading', { name: 'Heureux de te revoir.' })).toBeVisible();

  // Setup page is no longer reachable.
  await page.goto('/setup');
  await expect(page).toHaveURL(/\/signin$/);

  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Mot de passe', { exact: true }).fill('Wrong1234');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong email or password.');

  await page.getByLabel('Mot de passe', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/home$/);

  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect(page).toHaveURL(/\/signin$/);

  // Deep link while signed out → sign in → back to the deep link.
  await page.goto('/credentials');
  await expect(page).toHaveURL(/\/signin\?redirect=%2Fcredentials$/);
  await page.getByLabel('Email').fill(OWNER.email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL(/\/credentials$/);
});
