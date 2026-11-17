import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import JSZip from 'jszip';
import { resumeRestoredSession, terminateElectron } from './support/electronApp';

const fixtures = path.resolve(process.cwd(), '../../tests/fixtures/preview');
const fingerprint = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const chunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

async function unzipTexts(file: string, part: string, tag: RegExp): Promise<string[]> {
  const zip = await JSZip.loadAsync(await readFile(file));
  const xml = await zip.file(part)!.async('string');
  return [...xml.matchAll(tag)].map((match) => match[1]);
}

function startMockModel(file: string, toolName: string, buildOps: (fp: string) => unknown[]): Promise<Server> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (part) => { body += part; });
    request.on('end', async () => {
      const payload = JSON.parse(body) as { messages: Array<{ role: string }>; tools?: Array<{ function: { name: string } }> };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (payload.messages.some((message) => message.role === 'tool')) {
        response.end(chunk({ role: 'assistant', content: '已处理' }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
        return;
      }
      const names = (payload.tools ?? []).map((tool) => tool.function.name);
      if (!names.includes(toolName)) {
        response.end(chunk({ role: 'assistant', content: `missing ${toolName}` }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
        return;
      }
      const args = JSON.stringify({ fingerprint: fingerprint(await readFile(file)), ops: buildOps(fingerprint(await readFile(file))) });
      response.end(
        chunk({
          role: 'assistant',
          tool_calls: [{ index: 0, id: `call-${Date.now()}`, type: 'function', function: { name: toolName, arguments: args } }],
        }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n',
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launchOfficeAgent(opts: {
  relativePath: string;
  fixtureName: string;
  toolName: string;
  buildOps: (fp: string) => unknown[];
  previewReady: string;
}): Promise<{
  application: ElectronApplication;
  page: Awaited<ReturnType<ElectronApplication['firstWindow']>>;
  workspace: string;
  userData: string;
  temporary: string;
  file: string;
  server: Server;
  panel: ReturnType<Awaited<ReturnType<ElectronApplication['firstWindow']>>['locator']>;
}> {
  const temporary = await mkdtemp(path.join(process.cwd(), '.ai-office-e2e-'));
  const workspace = path.join(temporary, 'workspace');
  const userData = path.join(temporary, 'user-data');
  await mkdir(workspace);
  await mkdir(userData);
  const file = path.join(workspace, opts.relativePath);
  await copyFile(path.join(fixtures, opts.fixtureName), file);
  const markdown = path.join(workspace, 'notes.md');
  await writeFile(markdown, '# Notes\n');
  const server = await startMockModel(file, opts.toolName, opts.buildOps);
  const port = (server.address() as AddressInfo).port;
  await writeFile(
    path.join(userData, 'ai-chat-settings.json'),
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${port}`,
      models: ['mock'],
      defaultModel: 'mock',
      temperature: 1,
      topP: 1,
      maxTokens: 512,
      systemPrompt: '',
      stream: true,
    }),
  );
  await writeFile(
    path.join(userData, 'desktop-state.json'),
    JSON.stringify({
      recentFiles: [markdown],
      workspace: {
        rootPath: workspace,
        openTabs: [{ id: 'notes', kind: 'editor', filePath: markdown }],
        activeTabId: 'notes',
        expandedRelativePaths: [],
        explorerVisible: true,
        outlineVisible: false,
        explorerWidth: 240,
        outlineWidth: 240,
      },
    }),
  );
  const application = await electron.launch({
    args: [process.cwd(), `--user-data-dir=${userData}`],
    env: { ...process.env, EASYVIEW_DISABLE_UPDATE_CHECK: '1' },
  });
  const encrypted = await application.evaluate(({ safeStorage }) =>
    (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString('mock-key').toString('base64') : ''),
  );
  test.skip(!encrypted, 'safeStorage unavailable on this machine');
  await writeFile(path.join(userData, 'ai-chat-api-key.bin'), Buffer.from(encrypted, 'base64'));
  const page = await application.firstWindow();
  await resumeRestoredSession(page);
  await page.evaluate(async (entry) => {
    await (window as any).easyViewDesktop.tabs.openWorkspaceEntry(entry);
  }, opts.relativePath);
  await expect(page.locator(opts.previewReady).first()).toBeVisible({ timeout: 30_000 });
  await page.locator('#ai-chat-toggle').click();
  const panel = page.locator('#desktop-ai-chat-host .ai-chat-panel:not(.hidden):not(.suspended)');
  await expect(panel).toHaveCount(1);
  await expect(panel.locator('[data-mode="agent"]')).toBeEnabled();
  await panel.locator('.ai-chat-mode-current').click();
  await panel.locator('.ai-chat-mode-btn[data-mode="agent"]').click();
  await expect(panel.locator('.ai-chat-mode-label')).toHaveText('Agent');
  return { application, page, workspace, userData, temporary, file, server, panel };
}

test('Agent edits a docx preview via apply_docx_ops only after Apply, then undoes', async () => {
  const ctx = await launchOfficeAgent({
    relativePath: 'doc.docx',
    fixtureName: 'sample.docx',
    toolName: 'apply_docx_ops',
    previewReady: '.paged-editor__pages .layout-page, #file-preview-root .docx-wrapper',
    buildOps: () => [
      { op: 'replace_text', paragraphIndex: 0, search: 'EasyView', replaceWith: 'EasyViewAI' },
    ],
  });
  try {
    await ctx.panel.locator('.ai-chat-input').fill('把标题里的 EasyView 改成 EasyViewAI');
    await ctx.panel.locator('.ai-chat-send-btn').click();
    const edit = ctx.panel.locator('.ai-chat-office-edit').last();
    await expect(edit.locator('td.after')).toContainText('EasyViewAI');
    const before = await readFile(ctx.file);
    await edit.locator('.ai-chat-office-btn.apply').click();
    await expect(edit).toHaveClass(/\bapplied\b/);
    await expect.poll(async () => (await unzipTexts(ctx.file, 'word/document.xml', /<w:t[^>]*>([^<]*)<\/w:t>/g)).join('|')).toContain('EasyViewAI');
    expect((await readdir(path.join(ctx.userData, 'ai-backups'))).length).toBe(1);
    await edit.locator('.ai-chat-office-btn.undo').click();
    await expect(edit).toHaveClass(/\bundone\b/);
    expect(Buffer.compare(await readFile(ctx.file), before)).toBe(0);
  } finally {
    await terminateElectron(ctx.application);
    ctx.server.close();
    await rm(ctx.temporary, { recursive: true, force: true });
  }
});

test('Agent edits a pptx preview via apply_slide_ops only after Apply, then undoes', async () => {
  const ctx = await launchOfficeAgent({
    relativePath: 'deck.pptx',
    fixtureName: 'sample.pptx',
    toolName: 'apply_slide_ops',
    previewReady: '#file-preview-root',
    buildOps: () => [
      { op: 'replaceText', slideIndex: 0, search: 'PPTX fixture', replaceWith: 'PPTX e2e-edited' },
    ],
  });
  try {
    await expect(ctx.page.locator('#file-preview-root').getByText('EasyView PowerPoint').first()).toBeVisible({ timeout: 30_000 });
    await ctx.panel.locator('.ai-chat-input').fill('把 PPTX fixture 改成 PPTX e2e-edited');
    await ctx.panel.locator('.ai-chat-send-btn').click();
    const edit = ctx.panel.locator('.ai-chat-office-edit').last();
    await expect(edit.locator('td.after')).toContainText('PPTX e2e-edited');
    const before = await readFile(ctx.file);
    expect((await unzipTexts(ctx.file, 'ppt/slides/slide1.xml', /<a:t[^>]*>([^<]*)<\/a:t>/g)).join('|')).toContain('PPTX fixture');
    await edit.locator('.ai-chat-office-btn.apply').click();
    await expect(edit).toHaveClass(/\bapplied\b/);
    await expect.poll(async () => (await unzipTexts(ctx.file, 'ppt/slides/slide1.xml', /<a:t[^>]*>([^<]*)<\/a:t>/g)).join('|')).toContain('PPTX e2e-edited');
    expect((await readdir(path.join(ctx.userData, 'ai-backups'))).length).toBe(1);
    await edit.locator('.ai-chat-office-btn.undo').click();
    await expect(edit).toHaveClass(/\bundone\b/);
    expect(Buffer.compare(await readFile(ctx.file), before)).toBe(0);
  } finally {
    await terminateElectron(ctx.application);
    ctx.server.close();
    await rm(ctx.temporary, { recursive: true, force: true });
  }
});
