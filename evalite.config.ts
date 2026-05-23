import { defineConfig } from 'evalite/config';

export default defineConfig({
  setupFiles: ['./vitest.setup.ts'],
  testTimeout: 120_000,
});
