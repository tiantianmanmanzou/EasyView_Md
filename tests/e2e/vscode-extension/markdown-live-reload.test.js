const assert = require('node:assert');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

suite('EasyView Markdown external file changes', () => {
  let tempDir;

  setup(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyview-live-reload-'));
    const extension = vscode.extensions.getExtension('zhangxy.easyview-md');
    assert.ok(extension, 'EasyView_Md extension must be available to the extension host');
    await extension.activate();
  });

  teardown(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('updates an opened easyviewMd document after another process writes its disk file', async () => {
    const diskPath = path.join(tempDir, 'external-change.md');
    const diskUri = vscode.Uri.file(diskPath);
    const easyViewUri = diskUri.with({ scheme: 'easyviewMd' });
    await fs.writeFile(diskPath, '# Before\n', 'utf8');

    const document = await vscode.workspace.openTextDocument(easyViewUri);
    assert.strictEqual(document.getText(), '# Before\n');
    await vscode.commands.executeCommand('vscode.openWith', easyViewUri, 'easyviewMd.markdownEditor');

    await fs.writeFile(diskPath, '# Updated by another AI\n', 'utf8');
    await waitFor(() => document.getText() === '# Updated by another AI\n');
  });
});

suite('EasyView native editor for large Markdown', () => {
  let tempDir;

  setup(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyview-native-large-'));
    const extension = vscode.extensions.getExtension('zhangxy.easyview-md');
    assert.ok(extension, 'EasyView_Md extension must be available');
    await extension.activate();
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('opens a large file in the built-in text editor on the first command', async () => {
    const filePath = path.join(tempDir, 'large.md');
    await fs.writeFile(filePath, `# Large document\n\n${'Content line for native editor.\n'.repeat(16_000)}`, 'utf8');
    const uri = vscode.Uri.file(filePath);

    await vscode.commands.executeCommand('easyviewMd.openNativeEditor', uri);

    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab, 'expected an active editor tab');
    assert.ok(tab.input instanceof vscode.TabInputText, `expected built-in text editor, got ${tab.input?.constructor?.name}`);
    assert.equal(tab.input.uri.toString(), uri.toString());
  });

  test('switches from EasyView to native through the toolbar command without a URI argument', async () => {
    const filePath = path.join(tempDir, 'custom-large.md');
    await fs.writeFile(filePath, `# Large document\n\n${'Content line for custom editor.\n'.repeat(16_000)}`, 'utf8');
    const before = createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
    const diskUri = vscode.Uri.file(filePath);
    const easyViewUri = diskUri.with({ scheme: 'easyviewMd' });

    await vscode.commands.executeCommand('vscode.openWith', easyViewUri, 'easyviewMd.markdownEditor', { preview: false });
    const customTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(customTab.input instanceof vscode.TabInputCustom, `expected EasyView custom editor, got ${customTab.input?.constructor?.name}`);

    await vscode.commands.executeCommand('easyviewMd.openNativeEditor');

    const nativeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(nativeTab.input instanceof vscode.TabInputText, `expected built-in text editor, got ${nativeTab.input?.constructor?.name}`);
    assert.equal(nativeTab.input.uri.toString(), diskUri.toString());
    const after = createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
    assert.equal(after, before, 'opening editors must not modify the document');
  });
});
