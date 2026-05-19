import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import { execFile } from 'child_process';

export interface ExportImage {
  originalSrc: string;
  exportFilename: string;
  isExternal: boolean;
}

/**
 * Download a file from a URL via HTTP/HTTPS.
 * Follows redirects (up to 5 hops). Timeout 30s.
 */
export function downloadFile(url: string, maxRedirects = 5): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) { reject(new Error('Too many redirects')); return; }
    const mod = url.startsWith('https://') ? https : http;
    const request = mod.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let location = res.headers.location;
        // Handle relative redirects
        if (location.startsWith('/')) {
          const parsed = new URL(url);
          location = parsed.origin + location;
        }
        downloadFile(location, maxRedirects - 1).then(resolve).catch(reject);
        res.resume(); // Consume response to free resources
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Find a Chromium-based browser binary (Chrome, Edge, Chromium) on the system.
 * Returns the path or null if not found.
 */
export function findChromiumBinary(): string | null {
  const platform = process.platform;

  const candidates: string[] = [];

  if (platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || '';

    candidates.push(
      // Edge (most likely on Windows)
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      // Chrome
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      // Chrome per-user install
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      // Chromium
      path.join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
    );
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    // Linux
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
    );
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* skip */ }
  }

  return null;
}

/**
 * Generate PDF from HTML using headless Chromium's --print-to-pdf flag.
 * Returns the PDF file path on success, or null on failure.
 */
export function printToPdf(chromePath: string, htmlPath: string, pdfPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-extensions',
      '--run-all-compositor-stages-before-draw',
      '--print-to-pdf-no-header',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath.replace(/\\/g, '/')}`,
    ];

    execFile(chromePath, args, { timeout: 30000 }, (error) => {
      if (error) {
        console.error('[InLineMd] PDF generation failed:', error.message);
        resolve(null);
      } else {
        resolve(pdfPath);
      }
    });
  });
}
