import { defineConfig } from 'vitest/config';

// Generous limits: the first test of a file also starts the app, which can take > 5 s on a busy laptop.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], testTimeout: 20_000, hookTimeout: 30_000 },
});
