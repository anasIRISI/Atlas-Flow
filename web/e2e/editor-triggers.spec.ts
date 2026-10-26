import { expect, test } from '@playwright/test';
import { canvasNode, closePanel, expectStatus, openNewWorkflow } from './helpers';

const conn = (node: string) => ({ node, type: 'main', index: 0 });

test('activate toggle: production webhook works only while active; errors are shown', async ({ page }) => {
  const id = await openNewWorkflow(page, {
    name: 'E2E active',
    nodes: [
      { id: 'w', name: 'Webhook', type: 'flowforge.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'e2e-active', responseMode: 'lastNode' } },
      { id: 's', name: 'Reply', type: 'flowforge.set', typeVersion: 1, position: [240, 0], parameters: { assignments: { assignments: [{ id: 'a', name: 'ok', value: true, type: 'boolean' }] } } },
    ],
    connections: { Webhook: { main: [[conn('Reply')]] } },
  });
  expect((await page.request.get('/webhook/e2e-active')).status()).toBe(404);
  await expect(page.getByTestId('active-status')).toHaveAttribute('data-state', 'inactive');
  await page.getByTestId('active-toggle').click();
  await expect(page.getByTestId('active-status')).toHaveAttribute('data-state', 'active');
  const res = await page.request.get('/webhook/e2e-active');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });

  // The workflows list shows it as active and can deactivate it.
  await page.goto('/workflows');
  const row = page.locator('[data-testid="workflow-row"][data-name="E2E active"]');
  await expect(row.getByTestId('workflow-row-status')).toHaveText('Actif');
  await row.getByTestId('workflow-row-toggle').click();
  await expect(row.getByTestId('workflow-row-status')).toHaveText('Inactif');
  expect((await page.request.get('/webhook/e2e-active')).status()).toBe(404);

  // A workflow that cannot be activated says why.
  await openNewWorkflow(page, { name: 'E2E manual only', nodes: [{ id: 'm', name: 'Start', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: {} });
  await page.getByTestId('active-toggle').click();
  await expect(page.getByTestId('toast-error')).toContainText('no trigger that can be activated');
  await expect(page.getByTestId('active-status')).toHaveAttribute('data-state', 'failed');
  expect(id).toBeTruthy();
});

test('Listen for test event: a call to the test URL runs the workflow live in the editor', async ({ page }) => {
  await openNewWorkflow(page, {
    name: 'E2E listen',
    nodes: [
      { id: 'w', name: 'Webhook', type: 'flowforge.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'e2e-listen', httpMethod: 'POST' } },
      {
        id: 's',
        name: 'Greet',
        type: 'flowforge.set',
        typeVersion: 1,
        position: [240, 0],
        parameters: { assignments: { assignments: [{ id: 'a', name: 'greeting', value: '=Hello {{ $json.body.name }}', type: 'string' }] } },
      },
    ],
    connections: { Webhook: { main: [[conn('Greet')]] } },
  });
  await canvasNode(page, 'Webhook').dblclick();
  await expect(page.getByTestId('webhook-urls')).toBeVisible();
  await page.getByTestId('listen-test-event').click();
  const testUrl = await page.getByTestId('test-url').textContent();
  expect(testUrl).toContain('/webhook-test/e2e-listen');
  await expect(canvasNode(page, 'Webhook').getByTestId('node-listening')).toBeAttached();
  // "curl" the test URL from outside the page.
  const res = await page.request.post(new URL(testUrl!).pathname, { data: { name: 'Teacher' } });
  expect(res.status()).toBe(200);
  await expect(page.getByTestId('trigger-listening')).toHaveCount(0);
  await expect(page.getByTestId('output-panel')).toContainText('Teacher');
  await closePanel(page);
  await expectStatus(page, 'Webhook', 'success');
  await expectStatus(page, 'Greet', 'success');
  await canvasNode(page, 'Greet').dblclick();
  await expect(page.getByTestId('output-panel')).toContainText('Hello Teacher');
});

test('Wait node: the execution pauses, then resumes when its URL is called', async ({ page }) => {
  await openNewWorkflow(page, {
    name: 'E2E wait',
    nodes: [
      { id: 'm', name: 'Start', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'w', name: 'Wait for approval', type: 'flowforge.wait', typeVersion: 1, position: [240, 0], parameters: { resume: 'webhook' } },
      { id: 'd', name: 'Approved', type: 'flowforge.noOp', typeVersion: 1, position: [480, 0], parameters: {} },
    ],
    connections: { Start: { main: [[conn('Wait for approval')]] }, 'Wait for approval': { main: [[conn('Approved')]] } },
  });
  await page.getByTestId('execute-workflow').click();
  await expect(page.getByTestId('execution-status')).toHaveAttribute('data-status', 'waiting');
  await expectStatus(page, 'Wait for approval', 'waiting');
  await expectStatus(page, 'Approved', 'idle');
  const resumeUrl = await page.getByTestId('resume-url').textContent();
  expect(resumeUrl).toMatch(/\/webhook-waiting\/\d+$/);
  const res = await page.request.get(new URL(resumeUrl!).pathname + '?decision=yes');
  expect(res.status()).toBe(200);
  await expect(page.getByTestId('execution-status')).toHaveAttribute('data-status', 'success');
  await expectStatus(page, 'Wait for approval', 'success');
  await expectStatus(page, 'Approved', 'success');
  await canvasNode(page, 'Approved').dblclick();
  await expect(page.getByTestId('output-panel')).toContainText('decision');
});

test('workflow settings dialog: choose an error workflow and a timeout', async ({ page }) => {
  const errorWf = await page.request.post('/api/workflows', { data: { name: 'E2E error handler' } });
  expect(errorWf.ok()).toBe(true);
  await openNewWorkflow(page, { name: 'E2E settings', nodes: [{ id: 'm', name: 'Start', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: {} });
  await page.getByTestId('open-settings').click();
  await page.getByTestId('settings-errorWorkflow').selectOption({ label: 'E2E error handler' });
  await page.getByTestId('settings-timeout').fill('42');
  await page.getByTestId('settings-save').click();
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-dirty', 'false');
  await page.reload();
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-timeout')).toHaveValue('42');
  await expect(page.getByTestId('settings-errorWorkflow')).toHaveValue((await errorWf.json()).id);
});

test('a field type without an editor falls back to a JSON editor instead of crashing', async ({ page }) => {
  // Simulate a node from a newer server: one of its parameters has a type this editor does not know.
  await page.route('**/api/node-types', async (route) => {
    const response = await route.fetch();
    const types = (await response.json()) as { type: string; properties: { name: string; type: string }[] }[];
    for (const t of types) if (t.type === 'flowforge.wait') for (const p of t.properties) if (p.name === 'formFields') p.type = 'futureType';
    await route.fulfill({ response, json: types });
  });
  await openNewWorkflow(page, {
    name: 'E2E fallback',
    nodes: [
      { id: 'm', name: 'Start', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'w', name: 'Wait', type: 'flowforge.wait', typeVersion: 1, position: [240, 0], parameters: { resume: 'form' } },
    ],
    connections: { Start: { main: [[{ node: 'Wait', type: 'main', index: 0 }]] } },
  });
  await canvasNode(page, 'Wait').dblclick();
  const field = page.getByTestId('param-formFields');
  await expect(field).toContainText('Field type "futureType" has no editor yet. Edit it as JSON.');
  await expect(field.locator('.cm-content')).toContainText('fieldLabel');
  // The value stays editable: valid JSON typed into the editor is stored.
  await field.locator('.cm-content').fill('{"values":[{"fieldLabel":"Edited as JSON","fieldType":"text"}]}');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-dirty', 'true');
  await expect(page.getByTestId('param-formTitle')).toBeVisible();
});
