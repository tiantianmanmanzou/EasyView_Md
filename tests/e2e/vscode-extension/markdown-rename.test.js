const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { buildSync } = require('esbuild');

// Exercise the production rename entry point against the real extension host.
const source = path.resolve(__dirname, '../../../apps/vscode-extension/src/application/document/renameMarkdownResource.ts');
const compiled = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false });
const renameModule = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, renameModule, renameModule.exports);
const { renameMarkdownResource } = renameModule.exports;

async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for renamed editor');
}

suite('EasyView Markdown rename', () => {
  let directory;

  setup(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyview-rename-e2e-'));
    await vscode.extensions.getExtension('zhangxy.easyview-md').activate();
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('renames an open dirty editor, retains the file identity and saves only to the new path', async () => {
    const oldPath = path.join(directory, 'old.md');
    const newPath = path.join(directory, 'new.md');
    await fs.writeFile(oldPath, '# Original\n');
    const originalInode = (await fs.stat(oldPath)).ino;
    const diskUri = vscode.Uri.file(oldPath);
    const oldUri = diskUri.with({ scheme: 'easyviewMd' });
    const document = await vscode.workspace.openTextDocument(oldUri);
    await vscode.commands.executeCommand('vscode.openWith', oldUri, 'easyviewMd.markdownEditor', { preview: false });
    const edit = new vscode.WorkspaceEdit();
    edit.insert(oldUri, document.positionAt(document.getText().length), 'Unsaved content\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(document.isDirty, true);

    assert.equal(await renameMarkdownResource(diskUri, vscode.Uri.file(newPath)), true);
    const newUri = vscode.Uri.file(newPath).with({ scheme: 'easyviewMd' });
    await waitFor(() => vscode.window.tabGroups.all.some((group) => group.tabs.some((tab) =>
      tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === newUri.toString())));
    const renamed = await vscode.workspace.openTextDocument(newUri);
    assert.equal(renamed.getText(), '# Original\nUnsaved content\n');
    assert.equal((await fs.stat(newPath)).ino, originalInode, 'rename must retain the original file');
    assert.equal(await renamed.save(), true);
    assert.equal(await fs.readFile(newPath, 'utf8'), '# Original\nUnsaved content\n');
    await assert.rejects(fs.stat(oldPath), { code: 'ENOENT' });

    const nextPath = path.join(directory, 'final.md');
    assert.equal(await renameMarkdownResource(newUri, vscode.Uri.file(nextPath)), true);
    const finalDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(nextPath).with({ scheme: 'easyviewMd' }));
    const nextEdit = new vscode.WorkspaceEdit();
    nextEdit.insert(finalDocument.uri, new vscode.Position(0, 0), 'Saved after rename\n');
    assert.equal(await vscode.workspace.applyEdit(nextEdit), true);
    assert.equal(await finalDocument.save(), true);
    assert.deepEqual(await fs.readdir(directory), ['final.md']);
    assert.equal(await fs.readFile(nextPath, 'utf8'), 'Saved after rename\n# Original\nUnsaved content\n');
  });

  test('refuses an occupied target and leaves both original files intact', async () => {
    const oldPath = path.join(directory, 'old.md');
    const newPath = path.join(directory, 'new.md');
    await fs.writeFile(oldPath, 'original');
    await fs.writeFile(newPath, 'occupied');
    await vscode.workspace.openTextDocument(vscode.Uri.file(oldPath).with({ scheme: 'easyviewMd' }));
    assert.equal(await renameMarkdownResource(vscode.Uri.file(oldPath), vscode.Uri.file(newPath)), false);
    assert.equal(await fs.readFile(oldPath, 'utf8'), 'original');
    assert.equal(await fs.readFile(newPath, 'utf8'), 'occupied');
  });

  test('keeps only the renamed file when a save is already in progress', async () => {
    const oldPath = path.join(directory, 'old.md');
    const newPath = path.join(directory, 'new.md');
    await fs.writeFile(oldPath, 'original');
    const diskUri = vscode.Uri.file(oldPath);
    const document = await vscode.workspace.openTextDocument(diskUri.with({ scheme: 'easyviewMd' }));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, new vscode.Position(0, 0), 'concurrent save\n');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    const saving = document.save();
    assert.equal(await renameMarkdownResource(diskUri, vscode.Uri.file(newPath)), true);
    assert.equal(await saving, true);
    assert.deepEqual(await fs.readdir(directory), ['new.md']);
    assert.equal(await fs.readFile(newPath, 'utf8'), 'concurrent save\noriginal');
  });
});
