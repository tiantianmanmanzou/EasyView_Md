import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

const extensionDirectory = path.dirname(fileURLToPath(import.meta.url));
const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;

export default defineConfig({
  files: '../../tests/e2e/vscode-extension/**/*.test.js',
  extensionDevelopmentPath: extensionDirectory,
  workspaceFolder: '/Users/zhangxy/Downloads/00-数据安全管控能力基线原型 2',
  launchArgs: [
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
  ],
  ...(vscodeExecutablePath
    ? { useInstallation: { fromPath: vscodeExecutablePath } }
    : {}),
  mocha: {
    timeout: 45_000,
  },
});
