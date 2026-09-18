import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '../../tests/e2e/desktop',
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
});
