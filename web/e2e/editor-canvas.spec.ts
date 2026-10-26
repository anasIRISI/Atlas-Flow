import { expect, test, type Page } from '@playwright/test';
import { addNode, canvasNode, canvasNodes, closePanel, edges, fourNodeWorkflow, openNewWorkflow, runAndWait } from './helpers';

const twoNodes = (name: string) => ({
  name,
  nodes: [
    { id: 'a', name: 'Start', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'b', name: 'Next', type: 'flowforge.noOp', typeVersion: 1, position: [300, 0], parameters: {} },
  ],
  connections: {},
});

async function center(page: Page, name: string) {
  const box = (await canvasNode(page, name).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + 50 };
}

test('connect two nodes by dragging handles, delete the connection', async ({ page }) => {
  await openNewWorkflow(page, twoNodes('E2E connect'));
  await expect(edges(page)).toHaveCount(0);
  await canvasNode(page, 'Start').locator('.react-flow__handle.source').dragTo(canvasNode(page, 'Next').locator('.react-flow__handle.target'));
  await expect(edges(page)).toHaveCount(1);
  await page.locator('.react-flow__edge').click({ force: true });
  await page.getByTestId('edge-delete').click();
  await expect(edges(page)).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(edges(page)).toHaveCount(1);
});

test('box select several nodes and delete them at once', async ({ page }) => {
  await openNewWorkflow(page, fourNodeWorkflow('E2E box select'));
  const a = await center(page, 'Edit Fields');
  const b = await center(page, 'Result');
  await page.mouse.move(a.x - 90, a.y - 90);
  await page.mouse.down();
  await page.mouse.move(b.x + 90, b.y + 110, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(3);
  await page.keyboard.press('Delete');
  await expect(canvasNodes(page)).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(canvasNodes(page)).toHaveCount(4);
});

test('drag a node from the creator onto the canvas', async ({ page }) => {
  await openNewWorkflow(page, twoNodes('E2E drag create'));
  await page.getByTestId('open-node-creator').click();
  await page.getByTestId('node-creator-search').fill('limit');
  await page.getByTestId('creator-item-flowforge.limit').dragTo(page.locator('.react-flow__pane'), { targetPosition: { x: 300, y: 400 } });
  await expect(canvasNode(page, 'Limit')).toBeVisible();
  await expect(page.getByTestId('ndv')).toBeVisible();
  await expect(page.getByTestId('param-maxItems')).toBeVisible();
});

test('sticky notes: add, edit Markdown, recolor', async ({ page }) => {
  await openNewWorkflow(page, twoNodes('E2E sticky'));
  await page.locator('.react-flow__pane').click({ position: { x: 600, y: 600 } });
  await page.keyboard.press('Shift+S');
  const note = page.getByTestId('sticky-note');
  await expect(note).toHaveCount(1);
  await note.dblclick();
  await page.getByTestId('sticky-editor').fill('# Read me\nThis is **important**');
  await page.locator('.react-flow__pane').click({ position: { x: 50, y: 50 } });
  await expect(note.getByRole('heading', { name: 'Read me' })).toBeVisible();
  await expect(note.locator('strong')).toHaveText('important');
  await note.click();
  await note.getByTitle('Color').nth(4).click();
  await expect(note).toHaveAttribute('style', /rgba?\(92, 184, 255|#5cb8ff/i);
});

test('auto-layout tidies the canvas and can be undone', async ({ page }) => {
  const wf = fourNodeWorkflow('E2E layout');
  (wf.nodes as Array<{ position: number[] }>).forEach((n, i) => (n.position = [i * 40, i * 160]));
  await openNewWorkflow(page, wf);
  const before = (await canvasNode(page, 'Result').boundingBox())!;
  await page.getByTestId('auto-layout').click();
  await expect.poll(async () => (await canvasNode(page, 'Result').boundingBox())!.y).not.toBe(before.y);
  // Wait for the fit-view animation: the chain ends up on one horizontal line, left to right.
  await expect
    .poll(async () => Math.abs((await canvasNode(page, 'Result').boundingBox())!.y - (await canvasNode(page, 'Start').boundingBox())!.y))
    .toBeLessThan(20);
  expect((await canvasNode(page, 'Result').boundingBox())!.x).toBeGreaterThan((await canvasNode(page, 'Start').boundingBox())!.x);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => Math.abs((await canvasNode(page, 'Result').boundingBox())!.y - (await canvasNode(page, 'Start').boundingBox())!.y)).toBeGreaterThan(100);
});

test('settings: "continue (using error output)" adds an error output handle', async ({ page }) => {
  await openNewWorkflow(page, fourNodeWorkflow('E2E settings'));
  await expect(canvasNode(page, 'Edit Fields').getByText('error', { exact: true })).toHaveCount(0);
  await canvasNode(page, 'Edit Fields').dblclick();
  await page.getByTestId('ndv-tab-settings').click();
  await page.getByTestId('setting-onError').selectOption('continueErrorOutput');
  await page.getByTestId('setting-retryOnFail').click();
  await expect(page.getByText('Max Tries (1–5)')).toBeVisible();
  await closePanel(page);
  await expect(canvasNode(page, 'Edit Fields').getByText('error', { exact: true })).toBeVisible();
});

test('schema-driven forms: displayOptions, collections, code editor, multiple inputs', async ({ page }) => {
  await openNewWorkflow(page, twoNodes('E2E forms'));
  await canvasNode(page, 'Next').click();
  await addNode(page, 'merge', 'flowforge.merge');
  await expect(canvasNode(page, 'Merge').getByText('Input 2')).toBeVisible();
  await expect(page.getByTestId('param-combineBy')).toHaveCount(0);
  await page.getByTestId('param-mode').locator('select').selectOption({ label: 'Combine' });
  await expect(page.getByTestId('param-combineBy')).toBeVisible();
  await page.getByTestId('param-options-add').selectOption('fuzzyCompare');
  await expect(page.getByTestId('param-options-fuzzyCompare')).toBeVisible();
  await closePanel(page);

  await addNode(page, 'code', 'flowforge.code');
  await expect(page.getByTestId('param-jsCode-code').locator('.cm-content')).toContainText('return $input.all();');
  await closePanel(page);
});

test('expressions: autocomplete, live preview and drag a field from INPUT', async ({ page }) => {
  await openNewWorkflow(page, fourNodeWorkflow('E2E expressions'));
  await runAndWait(page);
  await canvasNode(page, 'Result').dblclick();
  await expect(page.getByTestId('input-count')).toHaveText('1 item');

  // Drag "age" from the INPUT table onto the value field: like n8n, it is appended to the existing text.
  await page.getByTestId('input-panel').locator('[data-drag-field="$json.age"]').first().dragTo(page.getByTestId('param-assignments-0-value'));
  await expect(page.getByTestId('param-assignments-0-value-editor-preview')).toHaveText('old enough 42');

  // Autocomplete after "$json." lists the input fields.
  await page.getByTestId('param-assignments-add').click();
  await page.getByTestId('param-assignments-1-value-toggle').click();
  const editor = page.getByTestId('param-assignments-1-value-editor').locator('.cm-content');
  await editor.click();
  await page.keyboard.type('{{');
  await page.keyboard.type('$json.');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('age');
  await page.locator('.cm-tooltip-autocomplete li', { hasText: 'age' }).first().click();
  await expect(page.getByTestId('param-assignments-1-value-editor-preview')).toHaveText('42');
  await expect(editor).toContainText('{{ $json.age }}');

  // Errors show in the preview.
  await editor.fill('{{ $json.nope.deeper }}');
  await expect(page.getByTestId('param-assignments-1-value-editor-preview')).toContainText('Cannot read properties of undefined');
});

test('views and run selector: Table / JSON / Schema, several runs of a node in a loop', async ({ page }) => {
  await openNewWorkflow(page, {
    name: 'E2E loop',
    nodes: [
      { id: '1', name: 'Start', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: '2', name: 'Numbers', type: 'flowforge.code', typeVersion: 1, position: [220, 0], parameters: { jsCode: 'return [1,2,3].map(n => ({ json: { n } }));' } },
      { id: '3', name: 'Loop', type: 'flowforge.splitInBatches', typeVersion: 1, position: [440, 0], parameters: { batchSize: 1 } },
      { id: '4', name: 'Square', type: 'flowforge.set', typeVersion: 1, position: [660, 120], parameters: { includeOtherFields: true, assignments: { assignments: [{ id: 'x', name: 'sq', value: '={{ $json.n * $json.n }}', type: 'number' }] } } },
    ],
    connections: {
      Start: { main: [[{ node: 'Numbers', type: 'main', index: 0 }]] },
      Numbers: { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
      Loop: { main: [[], [{ node: 'Square', type: 'main', index: 0 }]] },
      Square: { main: [[{ node: 'Loop', type: 'main', index: 0 }]] },
    },
  });
  await runAndWait(page);
  await expect(canvasNode(page, 'Square').getByTestId('node-item-count')).toContainText('3 runs');
  await canvasNode(page, 'Square').dblclick();
  const output = page.getByTestId('output-panel');
  await expect(output.getByTestId('run-selector').locator('option')).toHaveCount(3);
  await expect(output.getByTestId('data-table')).toContainText('9');
  await output.getByTestId('run-selector').selectOption({ label: 'Run 1 of 3' });
  await expect(output.getByTestId('data-table')).toContainText('1');
  await output.getByTestId('view-json').click();
  await expect(output.getByTestId('data-json')).toContainText('"sq": 1');
  await output.getByTestId('view-schema').click();
  await expect(output.getByTestId('data-schema')).toContainText('sq');
  await output.getByTestId('view-table').click();
});

test('stop a running execution', async ({ page }) => {
  await openNewWorkflow(page, {
    name: 'E2E stop',
    nodes: [
      { id: 'a', name: 'Start', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'b', name: 'Forever', type: 'flowforge.code', typeVersion: 1, position: [240, 0], parameters: { jsCode: 'while (true) {}' } },
    ],
    connections: { Start: { main: [[{ node: 'Forever', type: 'main', index: 0 }]] } },
  });
  await page.getByTestId('execute-workflow').click();
  await expect(canvasNode(page, 'Forever')).toHaveAttribute('data-status', 'running');
  await expect(page.locator('.ff-particle').first()).toBeAttached();
  await page.getByTestId('stop-execution').click();
  await expect(page.getByTestId('execution-status')).toHaveAttribute('data-status', 'canceled');
  await expect(page.getByTestId('execute-workflow')).toBeVisible();
});

test('workflows list: rename and delete', async ({ page }) => {
  const res = await page.request.post('/api/workflows', { data: { name: 'E2E list item' } });
  expect(res.ok()).toBe(true);
  await page.goto('/workflows');
  const row = page.locator('[data-testid="workflow-row"][data-name="E2E list item"]');
  await row.hover();
  await row.getByTestId('workflow-rename').click();
  await row.getByTestId('workflow-rename-input').fill('E2E list item renamed');
  await row.getByTestId('workflow-rename-input').press('Enter');
  const renamed = page.locator('[data-testid="workflow-row"][data-name="E2E list item renamed"]');
  await expect(renamed).toBeVisible();
  await renamed.hover();
  await renamed.getByTestId('workflow-delete').click();
  await page.getByTestId('confirm-ok').click();
  await expect(renamed).toHaveCount(0);
});

test('nodes with outputs computed on the server (Switch) draw all their connections', async ({ page }) => {
  const rule = (value: string) => ({
    conditions: { conditions: [{ leftValue: '={{ $json.p }}', rightValue: value, operator: { type: 'string', operation: 'equals' } }], combinator: 'and' },
    renameOutput: true,
    outputKey: value,
  });
  await openNewWorkflow(page, {
    name: 'E2E switch edges',
    nodes: [
      { id: '1', name: 'Start', type: 'flowforge.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: '2', name: 'Route', type: 'flowforge.switch', typeVersion: 1, position: [240, 0], parameters: { rules: { values: [rule('high'), rule('low')] }, options: { fallbackOutput: 'extra' } } },
      { id: '3', name: 'A', type: 'flowforge.noOp', typeVersion: 1, position: [480, -160], parameters: {} },
      { id: '4', name: 'B', type: 'flowforge.noOp', typeVersion: 1, position: [480, 0], parameters: {} },
      { id: '5', name: 'C', type: 'flowforge.noOp', typeVersion: 1, position: [480, 160], parameters: {} },
    ],
    connections: {
      Start: { main: [[{ node: 'Route', type: 'main', index: 0 }]] },
      Route: { main: [[{ node: 'A', type: 'main', index: 0 }], [{ node: 'B', type: 'main', index: 0 }], [{ node: 'C', type: 'main', index: 0 }]] },
    },
  });
  await expect(canvasNode(page, 'Route').getByText('Fallback')).toBeVisible();
  await expect(edges(page)).toHaveCount(4);
});
