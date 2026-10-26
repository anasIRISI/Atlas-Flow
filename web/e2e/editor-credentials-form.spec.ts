import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import PostalMime, { type Email } from 'postal-mime';
import { SMTPServer } from 'smtp-server';
import { addNode, canvasNode, canvasNodes, closePanel, edges, expectStatus, openNewWorkflow } from './helpers';

const LOGIN = { user: 'e2e@flowforge.test', pass: 'e2e-App-Passw0rd' };
const mails: { to: string[]; mail: Email }[] = [];
let smtp: SMTPServer;
let smtpPort = 0;

// A local SMTP server stands in for Gmail: no real key, no network.
test.beforeAll(async () => {
  smtp = new SMTPServer({
    secure: false,
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(auth, _session, callback) {
      if (auth.username === LOGIN.user && auth.password === LOGIN.pass) return callback(null, { user: auth.username });
      return callback(Object.assign(new Error('Invalid username or password'), { responseCode: 535 }));
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        void PostalMime.parse(Buffer.concat(chunks)).then((mail) => {
          mails.push({ to: session.envelope.rcptTo.map((r) => r.address), mail });
          callback();
        }, callback);
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  smtpPort = (smtp.server.address() as AddressInfo).port;
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
});

/** Fills the SMTP fields of the open credential dialog (fake server). */
async function fillSmtp(page: Page, name: string, password = LOGIN.pass) {
  await page.getByTestId('credential-name').fill(name);
  await page.getByTestId('credential-field-host').fill('127.0.0.1');
  await page.getByTestId('credential-field-port').fill(String(smtpPort));
  if ((await page.getByTestId('credential-field-secure').getAttribute('aria-checked')) === 'true') await page.getByTestId('credential-field-secure').click();
  await page.getByTestId('credential-field-user').fill(LOGIN.user);
  await page.getByTestId('credential-field-password').fill(password);
}

const row = (page: Page, name: string) => page.locator(`[data-testid="credential-row"][data-name=${JSON.stringify(name)}]`);

test('credentials page: create with a preset, test, save, edit without retyping the secret, delete', async ({ page }) => {
  await page.goto('/credentials');
  await page.getByTestId('create-credential').click();
  await expect(page.getByTestId('credential-dialog')).toContainText('Choose what you want to connect');
  await page.getByTestId('credential-type-smtp').click();

  // Fields come from the credential type schema; presets fill host, port and SSL.
  await page.getByTestId('credential-preset-brevo').click();
  await expect(page.getByTestId('credential-field-host')).toHaveValue('smtp-relay.brevo.com');
  await expect(page.getByTestId('credential-field-port')).toHaveValue('587');
  await expect(page.getByTestId('credential-field-secure')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('credential-preset-gmail').click();
  await expect(page.getByTestId('credential-field-host')).toHaveValue('smtp.gmail.com');
  await expect(page.getByTestId('credential-field-secure')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('credential-field-password')).toHaveAttribute('type', 'password');

  // Test button: wrong password, then the right one.
  await fillSmtp(page, 'E2E mail', 'not-the-password');
  await page.getByTestId('credential-test').click();
  await expect(page.getByTestId('credential-test-result')).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('credential-test-result')).toContainText('SMTP authentication failed');
  await page.getByTestId('credential-field-password').fill(LOGIN.pass);
  await page.getByTestId('credential-test').click();
  await expect(page.getByTestId('credential-test-result')).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('credential-test-result')).toContainText(`Connected to 127.0.0.1:${smtpPort}`);
  await page.getByTestId('credential-save').click();
  await expect(page.getByTestId('credential-dialog')).toHaveCount(0);
  await expect(row(page, 'E2E mail')).toContainText(`SMTP · 127.0.0.1 · ${smtpPort} · ${LOGIN.user}`);
  await expect(row(page, 'E2E mail').getByTestId('credential-default-badge')).toBeVisible();

  // The secret never comes back: not in the page, not in the API.
  await page.reload();
  await expect(row(page, 'E2E mail')).toBeVisible();
  expect(await page.content()).not.toContain(LOGIN.pass);
  expect(JSON.stringify(await (await page.request.get('/api/credentials')).json())).not.toContain(LOGIN.pass);

  // Edit: the password field is empty, the saved secret is kept (the row's Test still passes).
  await row(page, 'E2E mail').getByTestId('credential-edit').click();
  await expect(page.getByTestId('credential-field-password')).toHaveValue('');
  await expect(page.getByTestId('credential-field-password')).toHaveAttribute('placeholder', /saved/);
  await page.getByTestId('credential-name').fill('E2E mail (renamed)');
  await page.getByTestId('credential-test').click();
  await expect(page.getByTestId('credential-test-result')).toHaveAttribute('data-ok', 'true');
  await page.getByTestId('credential-save').click();
  await row(page, 'E2E mail (renamed)').getByTestId('credential-row-test-button').click();
  await expect(row(page, 'E2E mail (renamed)').getByTestId('credential-row-test')).toHaveAttribute('data-ok', 'true');

  // Validation errors of the server are shown in the dialog.
  await page.getByTestId('create-credential').click();
  await page.getByTestId('credential-type-httpBasicAuth').click();
  await page.getByTestId('credential-save').click();
  await expect(page.getByTestId('credential-error')).toContainText('Fill in: User, Password');
  await page.getByTestId('credential-close').click();

  await row(page, 'E2E mail (renamed)').getByTestId('credential-delete').click();
  await page.getByTestId('confirm-ok').click();
  await expect(row(page, 'E2E mail (renamed)')).toHaveCount(0);
  await expect(page.getByTestId('credentials-empty')).toBeVisible();
});

test('build Form → Send Email: missing credential error, create it from the node, test form with QR, then the production form', async ({ page, context }) => {
  mails.length = 0;
  await page.goto('/workflows');
  await page.getByTestId('create-workflow').click();
  await expect(page).toHaveURL(/\/workflow\//);
  const workflowId = page.url().split('/').pop()!;

  // ── Form Trigger with the visual builder ──
  await page.getByTestId('canvas-add-first-step').click();
  await page.getByTestId('node-creator-search').fill('form');
  await page.getByTestId('creator-item-flowforge.formTrigger').click();
  await canvasNode(page, 'On form submission').dblclick();
  await page.getByTestId('param-formTitle').locator('input').fill('Party sign-up');
  const builder = page.getByTestId('param-formFields');
  const preview = page.frameLocator('[data-testid="form-preview-frame"]');
  await expect(builder.getByTestId('param-formFields-count')).toHaveText('3');
  await expect(preview.locator('h1')).toHaveText('Party sign-up');
  await expect(preview.locator('.lbl')).toHaveText(['Name*', 'Email*', 'Message']);

  // Delete a field, add a dropdown and edit it.
  await page.getByTestId('param-formFields-2-delete').click();
  await page.getByTestId('param-formFields-add').click();
  await page.getByTestId('param-formFields-add-dropdown').click();
  await page.getByTestId('param-formFields-2-label').fill('Drink');
  await page.getByTestId('param-formFields-2-option-0').fill('Tea');
  await page.getByTestId('param-formFields-2-option-1').fill('Coffee');
  await page.getByTestId('param-formFields-2-option-add').click();
  await page.getByTestId('param-formFields-2-option-2').fill('Juice');
  await page.getByTestId('param-formFields-2-required').click();
  await page.getByTestId('param-formFields-2-help').fill('Free for everyone');
  // The live preview follows every change.
  await expect(preview.locator('.lbl')).toHaveText(['Name*', 'Email*', 'Drink*']);
  await expect(preview.locator('select option')).toHaveText(['Choose…', 'Tea', 'Coffee', 'Juice']);
  await expect(preview.locator('.help')).toHaveText('Free for everyone');

  // Reorder: buttons, then drag and drop.
  await page.getByTestId('param-formFields-2-up').click();
  await expect(preview.locator('.lbl')).toHaveText(['Name*', 'Drink*', 'Email*']);
  await page.getByTestId('param-formFields-0-handle').dragTo(page.getByTestId('param-formFields-2'), { targetPosition: { x: 80, y: 40 } });
  await expect(preview.locator('.lbl')).toHaveText(['Drink*', 'Email*', 'Name*']);
  await expect(page.getByTestId('param-formFields-2')).toHaveAttribute('data-label', 'Name');

  // A duplicate label is pointed out.
  await page.getByTestId('param-formFields-add').click();
  await page.getByTestId('param-formFields-add-text').click();
  await page.getByTestId('param-formFields-3-label').fill('Name');
  await expect(page.getByTestId('param-formFields-problem')).toContainText('2 fields are named "Name"');
  await page.getByTestId('param-formFields-3-delete').click();
  await expect(page.getByTestId('param-formFields-problem')).toHaveCount(0);

  // Themes.
  await expect(preview.locator('body')).toHaveAttribute('data-theme', 'midnight');
  await page.getByTestId('form-theme-daylight').click();
  await expect(preview.locator('body')).toHaveAttribute('data-theme', 'daylight');
  await page.getByTestId('form-preview-desktop').click();
  await page.getByTestId('form-theme-sunset').click();
  await expect(preview.locator('body')).toHaveAttribute('data-theme', 'sunset');

  // Form URLs + QR code (generated by the local server).
  await expect(page.getByTestId('webhook-url')).toContainText('/form-test/');
  await page.getByTestId('form-qr-button').click();
  await expect(page.getByTestId('qr-dialog')).toContainText('Party sign-up (test)');
  const qr = page.getByTestId('qr-image');
  await expect.poll(() => qr.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(400);
  await expect(page.getByTestId('qr-url')).toContainText('/form-test/');
  // The e2e server listens on 127.0.0.1 only: the editor warns that a phone cannot reach it.
  await expect(page.getByTestId('qr-dialog').getByTestId('reach-hint')).toHaveAttribute('data-source', 'localhost');
  await expect(page.getByTestId('qr-dialog').getByTestId('reach-hint')).toContainText('PUBLIC_URL');
  const download = await page.request.get((await page.getByTestId('qr-download').getAttribute('href'))!);
  expect(download.headers()['content-type']).toBe('image/png');
  expect(download.headers()['content-disposition']).toContain('form-qr-test.png');
  expect((await download.body()).subarray(1, 4).toString()).toBe('PNG');
  await page.getByTestId('qr-close').click();
  await closePanel(page);

  // ── Send Email ──
  await addNode(page, 'send email', 'flowforge.sendEmail');
  await expect(canvasNodes(page)).toHaveCount(2);
  await expect(edges(page)).toHaveCount(1);
  await expect(page.getByTestId('credential-status-smtp')).toHaveAttribute('data-status', 'none');
  await page.getByTestId('param-toEmail-expression').click();
  await page.getByTestId('param-toEmail-editor').locator('.cm-content').fill('{{ $json.Email }}');
  await page.getByTestId('param-subject').locator('input').fill('You are in!');
  await page.getByTestId('param-emailFormat').locator('select').selectOption({ label: 'Designed Template' });
  await page.getByTestId('param-templateTitle-expression').click();
  await page.getByTestId('param-templateTitle-editor').locator('.cm-content').fill('See you soon, {{ $json.Name }}!');
  await page.getByTestId('param-templateMessage').locator('textarea').fill('Your drink: we will have it ready.');
  await closePanel(page);

  // ── Test run without a credential: clear error + "Open Credentials" ──
  await canvasNode(page, 'On form submission').dblclick();
  await page.getByTestId('ndv-execute-step').click();
  await expect(page.getByTestId('trigger-listening')).toBeVisible();
  await expect(page.getByTestId('test-form-qr')).toBeVisible();
  const testPath = (await page.getByTestId('open-test-form').getAttribute('href'))!;
  expect(testPath).toMatch(/^\/form-test\//);

  const form = await context.newPage();
  await form.setViewportSize({ width: 390, height: 844 });
  await form.goto(testPath);
  await expect(form.locator('.banner')).toContainText('Test form');
  await expect(form.locator('body')).toHaveAttribute('data-theme', 'sunset');
  // Server-side validation, shown next to the fields.
  await form.getByLabel('Email').fill('not-an-email');
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.locator('[data-field="field-0"] .err')).toHaveText('Please choose an option');
  await expect(form.locator('[data-field="field-1"] .err')).toHaveText('Enter a valid email address, like name@example.com');
  await expect(form.locator('[data-field="field-2"] .err')).toHaveText('This field is required');
  await expect(form.locator('.form-error')).toHaveText('Please fix the highlighted fields.');
  await form.getByLabel('Drink').selectOption('Coffee');
  await form.getByLabel('Email').fill('guest@example.com');
  await form.getByLabel('Name').fill('Ada');
  await form.getByRole('button', { name: 'Submit' }).click();
  await expect(form.locator('.done h1')).toHaveText('Thank you!');
  await expect(form.locator('canvas.confetti')).toBeAttached();
  await form.close();

  // The run shows live in the editor; the email node fails with a credential error.
  await closePanel(page);
  await expectStatus(page, 'On form submission', 'success');
  await expectStatus(page, 'Send Email', 'error');
  await canvasNode(page, 'Send Email').dblclick();
  await expect(page.getByTestId('node-error-message')).toHaveText('SMTP credentials are missing');
  await expect(page.getByTestId('input-panel')).toContainText('guest@example.com');
  await page.getByTestId('open-credentials').click();
  await expect(page.getByTestId('credential-dialog')).toContainText('New SMTP credential');
  await fillSmtp(page, 'Party mail');
  await page.getByTestId('credential-test').click();
  await expect(page.getByTestId('credential-test-result')).toHaveAttribute('data-ok', 'true');
  await page.getByTestId('credential-save').click();
  // The new credential is selected on the node.
  await expect(page.getByTestId('credential-select-smtp').locator('option:checked')).toContainText('Party mail');
  await expect(page.getByTestId('credential-status-smtp')).toHaveAttribute('data-status', 'ok');

  // Execute only this step again with the same input: the email is sent.
  await page.getByTestId('ndv-execute-step').click();
  await expect(page.getByTestId('output-panel')).toContainText('guest@example.com', { timeout: 15_000 });
  await expect(page.getByTestId('output-panel')).toContainText('accepted');
  expect(mails).toHaveLength(1);
  expect(mails[0]!.to).toEqual(['guest@example.com']);
  expect(mails[0]!.mail.subject).toBe('You are in!');
  expect(mails[0]!.mail.html).toContain('See you soon, Ada!');
  expect(mails[0]!.mail.from?.address).toBe(LOGIN.user);
  await closePanel(page);

  // ── Production: activate, submit the public form, check the execution ──
  await page.getByTestId('active-toggle').click();
  await expect(page.getByTestId('active-status')).toHaveAttribute('data-state', 'active');
  const prodPath = testPath.replace('/form-test/', '/form/');
  const visitor = await context.newPage();
  await visitor.goto(prodPath);
  await expect(visitor.locator('.banner')).toHaveCount(0);
  await visitor.getByLabel('Drink').selectOption('Tea');
  await visitor.getByLabel('Email').fill('second@example.com');
  await visitor.getByLabel('Name').fill('Grace');
  await visitor.getByRole('button', { name: 'Submit' }).click();
  await expect(visitor.locator('.done h1')).toHaveText('Thank you!');
  await visitor.close();

  await expect.poll(() => mails.length, { timeout: 15_000 }).toBe(2);
  expect(mails[1]!.to).toEqual(['second@example.com']);
  expect(mails[1]!.mail.html).toContain('See you soon, Grace!');
  const list = (await (await page.request.get(`/api/executions?workflowId=${workflowId}`)).json()) as { items: unknown[] };
  const executions = list.items as { id: string; mode: string; status: string }[];
  const production = executions.find((e) => e.mode === 'webhook')!;
  expect(production.status).toBe('success');
  const detail = (await (await page.request.get(`/api/executions/${production.id}`)).json()) as { runData: Record<string, { data: { main: { json: Record<string, unknown> }[][] } }[]> };
  expect(detail.runData['On form submission']![0]!.data.main[0]![0]!.json).toMatchObject({ Drink: 'Tea', Email: 'second@example.com', Name: 'Grace', formMode: 'production' });
  expect(detail.runData['Send Email']![0]!.data.main[0]![0]!.json).toMatchObject({ accepted: ['second@example.com'] });
  // Nothing of the credential is in the stored execution.
  expect(JSON.stringify(detail)).not.toContain(LOGIN.pass);

  await page.getByTestId('active-toggle').click();
  await expect(page.getByTestId('active-status')).toHaveAttribute('data-state', 'inactive');
  expect((await page.request.get(prodPath)).status()).toBe(404);
});

test('examples: the contact form workflow is imported in one click', async ({ page }) => {
  await page.goto('/workflows');
  await page.getByTestId('open-examples').click();
  await expect(page.getByTestId('example-row')).toContainText(['Contact form → emails']);
  await page.getByTestId('import-example-form-to-email').click();
  await expect(page).toHaveURL(/\/workflow\//);
  await expect(page.getByTestId('workflow-name')).toContainText('Contact form → emails');
  await expect(canvasNodes(page)).toHaveCount(3);
  await expect(edges(page)).toHaveCount(2);
  // The default credential (if any) or a clear "needs a credential" notice is shown on the email nodes.
  await canvasNode(page, 'Send confirmation').dblclick();
  await expect(page.getByTestId('node-credential-smtp')).toBeVisible();
  await expect(page.getByTestId('param-templateTitle')).toContainText('Thanks');
});

test('Wait node "On Form Submitted" uses the same visual builder and live preview', async ({ page }) => {
  await openNewWorkflow(page, {
    name: 'E2E wait form',
    nodes: [
      { id: 'm', name: 'Start', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'w', name: 'Wait', type: 'flowforge.wait', typeVersion: 1, position: [240, 0], parameters: { resume: 'form', formTitle: 'Approve?' } },
    ],
    connections: { Start: { main: [[{ node: 'Wait', type: 'main', index: 0 }]] } },
  });
  await canvasNode(page, 'Wait').dblclick();
  const preview = page.frameLocator('[data-testid="form-preview-frame"]');
  await expect(preview.locator('h1')).toHaveText('Approve?');
  await expect(preview.locator('.lbl')).toHaveText(['Comment']);
  await page.getByTestId('param-formFields-add').click();
  await page.getByTestId('param-formFields-add-radio').click();
  await page.getByTestId('param-formFields-1-label').fill('Decision');
  await expect(preview.locator('.lbl')).toHaveText(['Comment', 'Decision']);
  await expect(preview.locator('input[type=radio]')).toHaveCount(2);
  // The input data stays one click away.
  await page.getByTestId('ndv-left-input').click();
  await expect(page.getByTestId('input-panel')).toBeVisible();
  // Other resume modes have no form: the preview goes away.
  await page.getByTestId('param-resume').locator('select').selectOption({ label: 'After Time Interval' });
  await expect(page.getByTestId('form-preview')).toHaveCount(0);
  await expect(page.getByTestId('input-panel')).toBeVisible();
});

test('Webhook authentication uses a credential chosen (or created) on the node', async ({ page }) => {
  await openNewWorkflow(page, {
    name: 'E2E webhook auth',
    nodes: [{ id: 'w', name: 'Webhook', type: 'flowforge.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'e2e-locked' } }],
    connections: {},
  });
  await canvasNode(page, 'Webhook').dblclick();
  // No authentication: no credential selector.
  await expect(page.getByTestId('node-credential-httpBasicAuth')).toHaveCount(0);
  await page.getByTestId('param-authentication').locator('select').selectOption({ label: 'Basic Auth' });
  await expect(page.getByTestId('credential-status-httpBasicAuth')).toHaveAttribute('data-status', 'none');
  await expect(page.getByTestId('node-credential-httpHeaderAuth')).toHaveCount(0);
  // The old inline password fields are gone.
  await expect(page.getByTestId('param-basicAuthPassword')).toHaveCount(0);
  await closePanel(page);

  // Activation explains what is missing.
  await page.getByTestId('active-toggle').click();
  await expect(page.getByTestId('toast-error')).toContainText('Basic Auth credentials are missing');
  await expect(page.getByTestId('active-status')).toHaveAttribute('data-state', 'failed');

  // "Create new credential…" from the selector.
  await canvasNode(page, 'Webhook').dblclick();
  await page.getByTestId('credential-select-httpBasicAuth').selectOption({ label: '+ Create new credential…' });
  await expect(page.getByTestId('credential-dialog')).toContainText('New Basic Auth credential');
  await page.getByTestId('credential-name').fill('Hook login');
  await page.getByTestId('credential-field-user').fill('ada');
  await page.getByTestId('credential-field-password').fill('s3cret-hook');
  await page.getByTestId('credential-save').click();
  await expect(page.getByTestId('credential-select-httpBasicAuth').locator('option:checked')).toContainText('Hook login');
  await closePanel(page);

  await page.getByTestId('active-toggle').click();
  await expect(page.getByTestId('active-status')).toHaveAttribute('data-state', 'active');
  expect((await page.request.get('/webhook/e2e-locked')).status()).toBe(401);
  const basic = (user: string, pass: string) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` });
  expect((await page.request.get('/webhook/e2e-locked', { headers: basic('ada', 'wrong') })).status()).toBe(403);
  expect((await page.request.get('/webhook/e2e-locked', { headers: basic('ada', 's3cret-hook') })).status()).toBe(200);
  // The saved workflow references the credential; the password is nowhere in it.
  const saved = JSON.stringify(await (await page.request.get(`/api/workflows/${page.url().split('/').pop()}`)).json());
  expect(saved).toContain('"httpBasicAuth":{"id":');
  expect(saved).not.toContain('s3cret-hook');
  await page.getByTestId('active-toggle').click();
  await expect(page.getByTestId('active-status')).toHaveAttribute('data-state', 'inactive');
});

test('a wrong password: "Open Credentials" opens the failing credential for editing', async ({ page }) => {
  mails.length = 0;
  const created = await page.request.post('/api/credentials', {
    data: { name: 'Broken mail', type: 'smtp', data: { host: '127.0.0.1', port: smtpPort, secure: false, user: LOGIN.user, password: 'typo' } },
  });
  expect(created.status()).toBe(201);
  const credential = (await created.json()) as { id: string };
  await openNewWorkflow(page, {
    name: 'E2E wrong password',
    nodes: [
      { id: 'm', name: 'Start', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: 's',
        name: 'Send Email',
        type: 'flowforge.sendEmail',
        typeVersion: 1,
        position: [240, 0],
        parameters: { toEmail: 'someone@example.com', subject: 'Hello', emailFormat: 'text', text: 'Hi' },
        credentials: { smtp: { id: credential.id, name: 'Broken mail' } },
      },
    ],
    connections: { Start: { main: [[{ node: 'Send Email', type: 'main', index: 0 }]] } },
  });
  await page.getByTestId('execute-workflow').click();
  await expectStatus(page, 'Send Email', 'error');
  await canvasNode(page, 'Send Email').dblclick();
  await expect(page.getByTestId('credential-select-smtp').locator('option:checked')).toContainText('Broken mail');
  await expect(page.getByTestId('node-error-message')).toContainText('SMTP authentication failed');
  await page.getByTestId('open-credentials').click();
  await expect(page.getByTestId('credential-dialog')).toContainText('Edit SMTP credential');
  await expect(page.getByTestId('credential-name')).toHaveValue('Broken mail');
  await page.getByTestId('credential-field-password').fill(LOGIN.pass);
  await page.getByTestId('credential-test').click();
  await expect(page.getByTestId('credential-test-result')).toHaveAttribute('data-ok', 'true');
  await page.getByTestId('credential-save').click();
  await page.getByTestId('ndv-execute-step').click();
  await expect(page.getByTestId('output-panel')).toContainText('someone@example.com', { timeout: 15_000 });
  expect(mails.map((m) => m.to[0])).toEqual(['someone@example.com']);
  await page.request.delete(`/api/credentials/${credential.id}`);
});
