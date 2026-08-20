import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:9876',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'node e2e/serve.mjs',
    url: 'http://127.0.0.1:9876',
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
