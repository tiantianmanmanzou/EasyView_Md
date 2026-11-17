import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Root unit-test discovery for `npm run test:unit` (layer 1, ci.yml).
 * Globs instead of a directory list, so a new package or test file can't be missed.
 * Unit tests live next to their code as `src/**\/*.test.ts`; e2e suites live in `apps/*\/e2e`.
 */
export default defineConfig({
  resolve: { alias: { 'bun:test': fileURLToPath(new URL('./tooling/testing/bun-test-compat.ts', import.meta.url)) } },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.{ts,tsx,js,mjs}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/e2e/**'],
  },
});
