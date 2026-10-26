import { expect, test, type Page } from '@playwright/test';
import { canvasNode, closePanel, expectStatus, openNewWorkflow, runAndWait } from './helpers';
import { PNG, startMockApi, type MockApi } from './mock-http';

let api: MockApi;
test.beforeAll(async () => {
  api = await startMockApi();
});
test.afterAll(async () => {
  await api.close();
});

const conn = (node: string, index = 0) => ({ node, type: 'main', index });
const manual = { id: 'm', name: 'Start', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} };
const http = (parameters: Record<string, unknown>) => ({ id: 'h', name: 'HTTP Request', type: 'flowforge.httpRequest', typeVersion: 1, position: [240, 0], parameters });
const option = (page: Page, param: string) => page.getByTestId(`param-${param}`).locator('select');

/** Runs the open node and waits until its output shows the given text. */
async function executeStep(page: Page, text: string | RegExp) {
  await page.getByTestId('ndv-execute-step').click();
  await expect(page.getByTestId('output-panel')).toContainText(text, { timeout: 15_000 });
}

test('HTTP Request: one credential selector per authentication type, and they are really used', async ({ page }) => {
  // Three credentials exist already; the fourth is created from the node.
  const ids: Record<string, string> = {};
  for (const data of [
    { name: 'E2E basic', type: 'httpBasicAuth', data: { user: 'ada', password: 'basic-pw-1' } },
    { name: 'E2E header', type: 'httpHeaderAuth', data: { name: 'X-API-Key', value: 'header-key-1' } },
    { name: 'E2E query', type: 'httpQueryAuth', data: { name: 'api_key', value: 'query-key-1' } },
  ]) {
    const res = await page.request.post('/api/credentials', { data });
    expect(res.status()).toBe(201);
    ids[data.type] = ((await res.json()) as { id: string }).id;
  }
  /** Picks the credential on the node (other tests may have left a different default of that type). */
  const choose = async (type: string, name: string) => {
    await page.getByTestId(`credential-select-${type}`).selectOption(ids[type]!);
    await expect(page.getByTestId(`credential-status-${type}`)).toContainText(`Using "${name}"`);
  };
  await openNewWorkflow(page, { name: 'E2E http auth', nodes: [manual, http({ url: `${api.url}/auth/basic` })], connections: { Start: { main: [[conn('HTTP Request')]] } } });
  await canvasNode(page, 'HTTP Request').dblclick();
  const selectors = ['httpBasicAuth', 'httpBearerAuth', 'httpHeaderAuth', 'httpQueryAuth'];
  const visible = async (type: string | null) => {
    for (const t of selectors) await expect(page.getByTestId(`node-credential-${t}`)).toHaveCount(t === type ? 1 : 0);
  };
  const url = page.getByTestId('param-url').locator('input');

  // None: no selector, and the API refuses the call with a clear error.
  await visible(null);
  await page.getByTestId('ndv-execute-step').click();
  await expect(page.getByTestId('node-error-message')).toHaveText('The server answered 401 Unauthorized');

  await option(page, 'authentication').selectOption({ label: 'Basic Auth' });
  await visible('httpBasicAuth');
  await choose('httpBasicAuth', 'E2E basic');
  await executeStep(page, 'basic');

  await option(page, 'authentication').selectOption({ label: 'API Key in a Header' });
  await visible('httpHeaderAuth');
  await choose('httpHeaderAuth', 'E2E header');
  await url.fill(`${api.url}/auth/header`);
  await executeStep(page, 'header');

  await option(page, 'authentication').selectOption({ label: 'API Key in the URL' });
  await visible('httpQueryAuth');
  await choose('httpQueryAuth', 'E2E query');
  await url.fill(`${api.url}/auth/query`);
  await executeStep(page, 'query');

  // Bearer: no credential yet → create it from the selector.
  await option(page, 'authentication').selectOption({ label: 'Bearer Token' });
  await visible('httpBearerAuth');
  await expect(page.getByTestId('credential-status-httpBearerAuth')).toHaveAttribute('data-status', 'none');
  await url.fill(`${api.url}/auth/bearer`);
  await page.getByTestId('ndv-execute-step').click();
  await expect(page.getByTestId('node-error-message')).toHaveText('Bearer Auth credentials are missing');
  await page.getByTestId('credential-select-httpBearerAuth').selectOption({ label: '+ Create new credential…' });
  await expect(page.getByTestId('credential-dialog')).toContainText('New Bearer Auth credential');
  await page.getByTestId('credential-name').fill('E2E bearer');
  await page.getByTestId('credential-field-token').fill('bearer-tok-1');
  await page.getByTestId('credential-save').click();
  await expect(page.getByTestId('credential-select-httpBearerAuth').locator('option:checked')).toContainText('E2E bearer');
  await executeStep(page, 'bearer');

  // The secrets were sent to the API, but are neither in the page nor in the saved workflow.
  expect(api.requests.some((r) => r.headers.authorization === 'Bearer bearer-tok-1')).toBe(true);
  await closePanel(page);
  await page.getByTestId('save-workflow').click();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-dirty', 'false');
  const saved = JSON.stringify(await (await page.request.get(`/api/workflows/${page.url().split('/').pop()}`)).json());
  expect(saved).toContain('"httpBearerAuth":{"id":');
  expect(saved).toContain(`"httpBasicAuth":{"id":"${ids.httpBasicAuth}","name":"E2E basic"}`);
  for (const secret of ['basic-pw-1', 'bearer-tok-1', 'header-key-1', 'query-key-1']) {
    expect(saved).not.toContain(secret);
    expect(await page.content()).not.toContain(secret);
  }
});

test('HTTP Request: import a cURL command (the token becomes a credential)', async ({ page }) => {
  await openNewWorkflow(page, { name: 'E2E curl', nodes: [manual, http({})], connections: { Start: { main: [[conn('HTTP Request')]] } } });
  await canvasNode(page, 'HTTP Request').dblclick();
  await page.getByTestId('curl-import-open').click();
  const input = page.getByTestId('curl-input');

  await input.fill('wget https://example.com');
  await expect(page.getByTestId('curl-error')).toHaveText('The command must start with "curl"');
  await expect(page.getByTestId('curl-import')).toBeDisabled();

  await input.fill(`curl -X POST '${api.url}/orders?dry=1' \\
  -H 'X-Trace: e2e-42' \\
  -H 'Authorization: Bearer curl-secret-token' \\
  -H 'Content-Type: application/json' \\
  --proxy http://127.0.0.1:9 \\
  -d '{"item":"pen","qty":2}'`);
  await expect(page.getByTestId('curl-summary')).toContainText(`POST ${api.url}/orders · 1 query parameter · 1 header · json body`);
  await expect(page.getByTestId('curl-warning')).toHaveText('The option --proxy is not supported and was ignored.');
  await expect(page.getByTestId('curl-as-credential')).toBeChecked();
  await page.getByTestId('curl-import').click();
  await expect(page.getByTestId('curl-dialog')).toHaveCount(0);

  // The form now shows the imported request.
  await expect(option(page, 'method')).toHaveValue('"POST"');
  await expect(page.getByTestId('param-url').locator('input')).toHaveValue(`${api.url}/orders`);
  await expect(option(page, 'authentication')).toHaveValue('"bearerAuth"');
  await expect(page.getByTestId('credential-select-httpBearerAuth').locator('option:checked')).toContainText('cURL import');
  await expect(page.getByTestId('param-queryParameters')).toBeVisible();
  await expect(page.getByTestId('param-headerParameters').locator('input').first()).toHaveValue('X-Trace');
  await expect(page.getByTestId('param-jsonBody')).toContainText('"qty": 2');

  await executeStep(page, 'e2e-42');
  await expect(page.getByTestId('output-panel')).toContainText('pen');
  const sent = api.requests.find((r) => r.path === '/orders')!;
  expect(sent.method).toBe('POST');
  expect(sent.headers.authorization).toBe('Bearer curl-secret-token');
  expect(JSON.parse(sent.body)).toEqual({ item: 'pen', qty: 2 });

  await closePanel(page);
  await page.getByTestId('save-workflow').click();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-dirty', 'false');
  const saved = JSON.stringify(await (await page.request.get(`/api/workflows/${page.url().split('/').pop()}`)).json());
  expect(saved).not.toContain('curl-secret-token');
  // One undo brings the empty node back.
  await page.keyboard.press('Control+z');
  await canvasNode(page, 'HTTP Request').dblclick();
  await expect(page.getByTestId('param-url').locator('input')).toHaveValue('');
});

test('files: a downloaded file shows in the Binary view; pagination collects every page', async ({ page }) => {
  await openNewWorkflow(page, {
    name: 'E2E files',
    nodes: [
      manual,
      http({ url: `${api.url}/file` }),
      {
        id: 'p',
        name: 'Pages',
        type: 'flowforge.httpRequest',
        typeVersion: 1,
        position: [240, 180],
        parameters: { url: `${api.url}/items`, paginationMode: 'updateAParameterInEachRequest', paginationParameters: { values: [{ type: 'qs', name: 'page', value: '{{ $pageCount + 1 }}' }] } },
      },
    ],
    connections: { Start: { main: [[conn('HTTP Request'), conn('Pages')]] } },
  });
  await runAndWait(page);
  await canvasNode(page, 'HTTP Request').dblclick();
  // The table links to the file; the Binary view shows it with a download link.
  await expect(page.getByTestId('table-files')).toContainText('pixel.png');
  await page.getByTestId('view-binary').click();
  const file = page.getByTestId('binary-file');
  await expect(file.getByTestId('binary-file-name')).toHaveText('pixel.png');
  await expect(file).toContainText('image/png');
  await expect(file).toHaveAttribute('data-property', 'data');
  const download = await page.request.get((await file.getByTestId('binary-download').getAttribute('href'))!);
  expect(download.headers()['content-disposition']).toContain('attachment');
  expect((await download.body()).equals(PNG)).toBe(true);
  await closePanel(page);

  await canvasNode(page, 'Pages').dblclick();
  await expect(page.getByTestId('output-count')).toHaveText('4 items');
  await expect(page.getByTestId('view-binary')).toHaveCount(0);
  expect(api.requests.filter((r) => r.path === '/items')).toHaveLength(3);
});

test('Execute Command is disabled until the Settings toggle is switched on', async ({ page }) => {
  const id = await openNewWorkflow(page, {
    name: 'E2E command',
    nodes: [manual, { id: 'c', name: 'Execute Command', type: 'flowforge.executeCommand', typeVersion: 1, position: [240, 0], parameters: { command: 'echo hello-from-e2e' } }],
    connections: { Start: { main: [[conn('Execute Command')]] } },
  });
  await page.getByTestId('execute-workflow').click();
  await expectStatus(page, 'Execute Command', 'error');
  await canvasNode(page, 'Execute Command').dblclick();
  await expect(page.getByTestId('node-error-message')).toHaveText('The Execute Command node is disabled');
  await expect(page.getByTestId('node-error')).toContainText('Settings → Security');

  // Settings: off by default, a confirmation is asked before enabling.
  await page.goto('/settings');
  const toggle = page.getByTestId('setting-executeCommandEnabled');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('setting-executeCommand-state')).toHaveText('Disabled (safe).');
  await toggle.click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('Allow shell commands?');
  await page.getByTestId('confirm-cancel').click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await page.getByTestId('confirm-ok').click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('setting-executeCommand-state')).toContainText('Enabled');
  await page.reload();
  await expect(page.getByTestId('setting-executeCommandEnabled')).toHaveAttribute('aria-checked', 'true');

  await page.goto(`/workflow/${id}`);
  await runAndWait(page);
  await canvasNode(page, 'Execute Command').dblclick();
  await expect(page.getByTestId('output-panel')).toContainText('hello-from-e2e');
  await closePanel(page);

  // Switch it off again: the node is refused at once.
  await page.goto('/settings');
  await page.getByTestId('setting-executeCommandEnabled').click();
  await expect(page.getByTestId('setting-executeCommandEnabled')).toHaveAttribute('aria-checked', 'false');
  expect((await (await page.request.get('/api/settings')).json()).executeCommandEnabled).toBe(false);
  await page.goto(`/workflow/${id}`);
  await page.getByTestId('execute-workflow').click();
  await expectStatus(page, 'Execute Command', 'error');
});

test('data nodes: summarize → CSV file → back to items, configured in the editor', async ({ page }) => {
  const code = `return [
  { json: { city: 'Paris', product: 'pen', amount: 10 } },
  { json: { city: 'Paris', product: 'ink', amount: 5.5 } },
  { json: { city: 'Lyon', product: 'pen', amount: 4 } },
];`;
  const at = (x: number) => [x, 0];
  await openNewWorkflow(page, {
    name: 'E2E data nodes',
    nodes: [
      manual,
      { id: 'c', name: 'Sales', type: 'flowforge.code', typeVersion: 1, position: at(220), parameters: { jsCode: code } },
      { id: 's', name: 'Summarize', type: 'flowforge.summarize', typeVersion: 1, position: at(440), parameters: {} },
      { id: 'f', name: 'Convert to File', type: 'flowforge.convertToFile', typeVersion: 1, position: at(660), parameters: {} },
      { id: 'x', name: 'Extract from File', type: 'flowforge.extractFromFile', typeVersion: 1, position: at(880), parameters: {} },
      { id: 'd', name: 'Date & Time', type: 'flowforge.dateTime', typeVersion: 1, position: at(1100), parameters: {} },
    ],
    connections: {
      Start: { main: [[conn('Sales')]] },
      Sales: { main: [[conn('Summarize')]] },
      Summarize: { main: [[conn('Convert to File')]] },
      'Convert to File': { main: [[conn('Extract from File')]] },
      'Extract from File': { main: [[conn('Date & Time')]] },
    },
  });

  // Summarize: sum of "amount" per city, set up with the generated form.
  await canvasNode(page, 'Summarize').dblclick();
  const row = page.getByTestId('param-fieldsToSummarize-values-0');
  await row.getByTestId('param-fieldsToSummarize-values-0-aggregation').locator('select').selectOption({ label: 'Sum' });
  await row.getByTestId('param-fieldsToSummarize-values-0-field').locator('input').fill('amount');
  await page.getByTestId('param-fieldsToSplitBy').locator('input').fill('city');
  await closePanel(page);

  // Date & Time: the form follows the chosen operation.
  await canvasNode(page, 'Date & Time').dblclick();
  await expect(page.getByTestId('param-date')).toBeVisible();
  await expect(page.getByTestId('param-magnitude')).toHaveCount(0);
  await option(page, 'operation').selectOption({ label: 'Add to a Date' });
  await expect(page.getByTestId('param-date')).toHaveCount(0);
  await page.getByTestId('param-magnitude').locator('input').fill('2026-03-14');
  await page.getByTestId('param-duration').locator('input').fill('20');
  await closePanel(page);

  await runAndWait(page);
  await canvasNode(page, 'Summarize').dblclick();
  await expect(page.getByTestId('output-count')).toHaveText('2 items');
  await expect(page.getByTestId('output-panel')).toContainText('sum_amount');
  await expect(page.getByTestId('output-panel')).toContainText('15.5');
  await closePanel(page);

  await canvasNode(page, 'Convert to File').dblclick();
  await expect(page.getByTestId('table-files')).toContainText('file.csv');
  await page.getByTestId('view-binary').click();
  const csv = await page.request.get((await page.getByTestId('binary-view').getAttribute('href'))!);
  expect(await csv.text()).toBe('city,sum_amount\nParis,15.5\nLyon,4\n');
  await closePanel(page);

  await canvasNode(page, 'Date & Time').dblclick();
  await expect(page.getByTestId('output-count')).toHaveText('2 items');
  await expect(page.getByTestId('output-panel')).toContainText('2026-04-03T00:00:00.000');
  await expect(page.getByTestId('output-panel')).toContainText('Lyon');
  await expect(page.getByTestId('input-panel')).toContainText('from Extract from File');
});
