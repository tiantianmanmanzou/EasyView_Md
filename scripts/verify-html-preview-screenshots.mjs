#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const htmlDir = '/Users/zhangxy/GAFile/数运平台/项目管理/数管汇报材料/00-数据安全管控能力基线原型 2';
const htmlFile = path.join(htmlDir, '数据安全管控能力基线.html');
const outDir = path.join(process.cwd(), '.tmp', 'html-preview-verify');
const userData = path.join(outDir, 'user-data');
const electron = '/Applications/Visual Studio Code.app/Contents/MacOS/Electron';
const extensionPath = path.join(process.cwd(), 'apps/vscode-extension');
const debugPort = 9334;

function mime(filePath) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function startStaticServer(root) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const relative = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
      const filePath = path.resolve(root, relative || '数据安全管控能力基线.html');
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (!existsSync(filePath)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': mime(filePath) });
      createReadStream(filePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}

async function screenshotBrowser(port) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/${encodeURIComponent('数据安全管控能力基线.html')}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const empty = await page.locator('text=请从左侧菜单选择功能').count();
  const menu = await page.locator('.menu-row').count();
  await page.screenshot({ path: path.join(outDir, 'browser-shell.png'), fullPage: true });
  if (menu > 0) {
    await page.locator('.menu-row', { hasText: '数据资源管理' }).first().click();
    await page.waitForTimeout(200);
    await page.locator('.menu-row', { hasText: '文件服务管理' }).first().click();
    await page.waitForTimeout(800);
  }
  await page.screenshot({ path: path.join(outDir, 'browser-page.png'), fullPage: true });
  const after = {
    menuRows: await page.locator('.menu-row').count(),
    emptyHint: await page.locator('text=请从左侧菜单选择功能').count(),
    tableRows: await page.locator('table tr').count(),
  };
  await browser.close();
  return { emptyBefore: empty, menuBefore: menu, ...after };
}

async function screenshotVsCode() {
  mkdirSync(path.join(userData, 'User'), { recursive: true });
  writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'workbench.editorAssociations': {
      '*.html': 'easyviewMd.filePreview',
    },
  }, null, 2));

  const child = spawn(electron, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userData}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    `--extensionDevelopmentPath=${extensionPath}`,
    htmlDir,
    htmlFile,
  ], {
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });

  try {
    await waitFor(`http://127.0.0.1:${debugPort}/json/version`, 20000);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (const page of pages) {
      for (const frame of page.frames()) {
        if (!frame.url().startsWith('http://127.0.0.1')) continue;
        const resource = frame.locator('.menu-row', { hasText: '数据资源管理' }).first();
        if (await resource.count()) {
          await resource.click();
          await page.waitForTimeout(300);
          const fileMenu = frame.locator('.menu-row', { hasText: '文件服务管理' }).first();
          if (await fileMenu.count()) {
            await fileMenu.click();
            await page.waitForTimeout(1200);
          }
        }
      }
    }
    const report = [];
    let index = 0;
    for (const page of pages) {
      const url = page.url();
      const title = await page.title().catch(() => '');
      const file = path.join(outDir, `vscode-${index}.png`);
      await page.screenshot({ path: file, fullPage: true }).catch(() => {});
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 800) || '').catch(() => '');
      const frames = [];
      for (const frame of page.frames()) {
        frames.push({
          url: frame.url(),
          text: await frame.evaluate(() => document.body?.innerText?.slice(0, 400) || '').catch(() => ''),
          menuRows: await frame.locator('.menu-row').count().catch(() => 0),
        });
      }
      report.push({ index, url, title, file, bodyText, frames });
      index += 1;
    }
    await browser.close();
    return report;
  } finally {
    child.kill('SIGTERM');
  }
}

async function waitFor(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${url}`);
}

if (!existsSync(htmlFile)) {
  console.error('missing html file', htmlFile);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const { server, port } = await startStaticServer(htmlDir);
try {
  const browserStats = await screenshotBrowser(port);
  const vscodeStats = await screenshotVsCode();
  const summary = { htmlFile, browserStats, vscodeStats };
  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  server.close();
}
