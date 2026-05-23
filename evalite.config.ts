import { defineConfig } from 'evalite/config';
import { createSqliteStorage } from 'evalite/sqlite-storage';

export default defineConfig({
  setupFiles: ['./evals/setup.ts'],
  testTimeout: 120_000,
  storage: () => createSqliteStorage('./evals/db/runs.sqlite'),
});
