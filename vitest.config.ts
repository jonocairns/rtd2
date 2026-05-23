import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The Nix flake snapshot under .direnv/flake-inputs/<hash>-source/ contains a
    // copy of evals/ and would double-run every scenario at API spend cost.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.direnv/**'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
  },
});
