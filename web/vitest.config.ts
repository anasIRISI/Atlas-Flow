import { defineConfig } from 'vitest/config';

// Unit tests only (browser tests in e2e/ run with Playwright).
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
