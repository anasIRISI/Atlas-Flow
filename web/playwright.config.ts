import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 5699);
// PW_CHANNEL=chrome uses the Google Chrome already installed on the machine (no browser download needed).
const channel = process.env.PW_CHANNEL || undefined;
const browser = { ...devices['Desktop Chrome'], channel, viewport: { width: 1440, height: 900 } };
export const STORAGE_STATE = '../.e2e-data/storage-state.json';

// Runs against the BUILT app (same code path as `npm start`) with a fresh throw-away data directory.
// Order: phase0 (fresh install, creates the owner) → auth (signs in once) → editor tests.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'phase0', testMatch: /phase0-.*\.spec\.ts/, use: browser },
    { name: 'auth', testMatch: /auth\.setup\.ts/, dependencies: ['phase0'], use: browser },
    { name: 'editor', testMatch: /(editor|product)-.*\.spec\.ts/, dependencies: ['auth'], use: { ...browser, storageState: STORAGE_STATE } },
  ],
  webServer: {
    command: 'node ../scripts/e2e-server.mjs',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { E2E_PORT: String(PORT) },
  },
});
