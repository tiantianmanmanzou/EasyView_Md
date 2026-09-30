const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const htmlRoot = '/Users/zhangxy/Downloads/00-数据安全管控能力基线原型 2';
const htmlFile = path.join(htmlRoot, '数据安全管控能力基线.html');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPreviewState(predicate, timeoutMs = 15000) {
  const started = Date.now();
  let state = null;
  while (Date.now() - started < timeoutMs) {
    state = await vscode.commands.executeCommand('easyviewMd.debug.htmlPreviewState');
    if (state && predicate(state)) return state;
    await sleep(400);
  }
  return state;
}

suite('EasyView HTML preview in VS Code', () => {
  test('renders the local shell and a sibling iframe page', async () => {
    assert.ok(fs.existsSync(htmlFile), `missing fixture: ${htmlFile}`);

    const extension = vscode.extensions.getExtension('zhangxy.easyview-md');
    assert.ok(extension, 'zhangxy.easyview-md is not available in this VS Code');
    await extension.activate();

    const uri = vscode.Uri.file(htmlFile);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'easyviewMd.filePreview');
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => ({
      label: tab.label,
      viewType: tab.input && tab.input.viewType,
    })));
    assert.ok(
      tabs.some((tab) => tab.viewType === 'easyviewMd.filePreview'),
      `custom editor did not open: ${JSON.stringify(tabs)}`,
    );

    const shell = await waitForPreviewState((state) => (
      typeof state.text === 'string'
      && state.text.includes('数据安全管控能力基线')
      && state.text.includes('请从左侧菜单选择功能')
    ));
    assert.ok(shell, 'html preview state command returned nothing');
    assert.ok(shell.panels > 0, `file preview panel missing: ${JSON.stringify(shell)}`);
    assert.ok(shell.text.includes('数据安全管控能力基线'), `shell title missing: ${JSON.stringify(shell)}`);
    assert.ok(shell.text.includes('请从左侧菜单选择功能'), `shell empty hint missing: ${JSON.stringify(shell)}`);
    assert.match(shell.contentUrl, /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//, `expected local http preview: ${shell.contentUrl}`);

    const shellHtml = await fetch(shell.contentUrl).then((response) => {
      assert.equal(response.ok, true, `shell http ${response.status}`);
      return response.text();
    });
    assert.ok(shellHtml.includes('请从左侧菜单选择功能'), 'local server did not serve the shell HTML');

    const siblingUrl = new URL('dsmp/DataAssetMangerment/文件服务管理原型.html', shell.contentUrl).toString();
    const siblingHtml = await fetch(siblingUrl).then((response) => {
      assert.equal(response.ok, true, `sibling http ${response.status}: ${siblingUrl}`);
      return response.text();
    });
    assert.ok(siblingHtml.includes('文件服务') || siblingHtml.includes('文件'), `sibling page missing: ${siblingUrl}`);
  });
});
