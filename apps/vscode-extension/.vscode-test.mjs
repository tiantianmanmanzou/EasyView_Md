import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

const extensionDirectory = path.dirname(fileURLToPath(import.meta.url));
const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;

export default defineConfig({
  files: '../../tests/e2e/vscode-extension/**/*.test.js',
  extensionDevelopmentPath: extensionDirectory,
  ...(vscodeExecutablePath
    ? { useInstallation: { fromPath: vscodeExecutablePath } }
    : {}),
  mocha: {
    timeout: 30_000,
  },
});
