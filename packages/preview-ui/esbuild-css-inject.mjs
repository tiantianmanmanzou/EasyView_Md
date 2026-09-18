import { createHash } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const MIME_BY_EXT = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

/**
 * esbuild ESM + splitting writes imported CSS to orphan chunk files that a
 * VS Code / Electron webview never <link>s. Convert CSS imports into JS that
 * injects a <style> tag once, so dynamic viewer styles (docx-editor, x-spreadsheet)
 * actually apply at runtime.
 *
 * Relative url(...) assets are inlined as base64 data URLs (avoids quote-escaping
 * breakage that utf-8 SVG data URLs hit inside CSS).
 */
export function cssInjectPlugin() {
  return {
    name: 'easyview-css-inject',
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, async (args) => {
        const raw = await readFile(args.path, 'utf8');
        const css = await inlineCssUrls(raw, args.path);
        const id = `ev-css-${createHash('sha1').update(args.path).digest('hex').slice(0, 12)}`;
        return {
          contents: `
const css = ${JSON.stringify(css)};
if (typeof document !== 'undefined') {
  if (!document.getElementById(${JSON.stringify(id)})) {
    const el = document.createElement('style');
    el.id = ${JSON.stringify(id)};
    el.textContent = css;
    document.head.appendChild(el);
  }
}
export default css;
`,
          loader: 'js',
        };
      });
    },
  };
}

async function inlineCssUrls(cssText, cssFilePath) {
  const dir = path.dirname(cssFilePath);
  const parts = [];
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let last = 0;
  let match;
  while ((match = re.exec(cssText))) {
    parts.push(cssText.slice(last, match.index));
    const ref = match[2].trim();
    if (!ref || /^(data:|https?:|blob:|\/\/)/i.test(ref)) {
      parts.push(match[0]);
    } else {
      const filePath = path.resolve(dir, ref.split('#')[0].split('?')[0]);
      try {
        const bytes = await readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
        parts.push(`url("data:${mime};base64,${bytes.toString('base64')}")`);
      } catch {
        parts.push(match[0]);
      }
    }
    last = match.index + match[0].length;
  }
  parts.push(cssText.slice(last));
  return parts.join('');
}
