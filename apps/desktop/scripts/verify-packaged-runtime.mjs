import { _electron as electron, expect } from '@playwright/test';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundleRoot = path.join(appDir, 'out', `EasyView_Md-${process.platform}-${process.arch}`);
const executablePath = process.platform === 'darwin'
  ? path.join(bundleRoot, 'EasyView_Md.app', 'Contents', 'MacOS', 'EasyView_Md')
  : path.join(bundleRoot, 'EasyView_Md.exe');
const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'easyview-packaged-runtime-'));
const documentPath = path.join(tempDirectory, 'packaged-runtime.md');
const userDataDirectory = path.join(tempDirectory, 'user-data');
await writeFile(documentPath, '# Packaged EasyView_Md\n\nRuntime check.\n', 'utf8');

const application = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userDataDirectory}`, documentPath],
  env: { ...process.env, NODE_OPTIONS: '' },
});

try {
  const page = await application.firstWindow();
  await expect(page.locator('.ProseMirror')).toContainText('Packaged EasyView_Md');

  await page.keyboard.press('Alt+t');
  const terminal = page.locator('.easyview-terminal-modal');
  await expect(terminal).toBeVisible();
  const terminalInput = terminal.locator('.xterm-helper-textarea');
  await terminalInput.focus();
  await page.keyboard.type(
    process.platform === 'win32'
      ? 'echo EASYVIEW_PACKAGED_TERMINAL_OK'
      : 'printf EASYVIEW_PACKAGED_TERMINAL_OK',
  );
  await page.keyboard.press('Enter');
  await expect(terminal.locator('.xterm-rows')).toContainText(
    'EASYVIEW_PACKAGED_TERMINAL_OK',
    { timeout: 10_000 },
  );
  await terminal.locator('[data-action="close"]').click({ force: true });

  const paragraph = page.locator('.ProseMirror p').last();
  await paragraph.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Packaged saved.');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
  await expect.poll(async () => readFile(documentPath, 'utf8')).toContain(
    'Runtime check. Packaged saved.',
  );

  console.log(`verified packaged runtime ${executablePath}`);
} finally {
  const applicationProcess = application.process();
  if (applicationProcess.exitCode === null) {
    const exited = once(applicationProcess, 'exit');
    applicationProcess.kill('SIGTERM');
    await exited;
  }
  await application.close();
  await rm(tempDirectory, { recursive: true, force: true });
}
