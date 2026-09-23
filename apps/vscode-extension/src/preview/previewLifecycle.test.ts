import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const previewProviderSource = fs.readFileSync(
  path.resolve(__dirname, 'filePreviewProvider.ts'),
  'utf8',
);
const previewWebviewSource = fs.readFileSync(
  path.resolve(__dirname, 'previewWebview.ts'),
  'utf8',
);
const esbuildSource = fs.readFileSync(
  path.resolve(__dirname, '../../esbuild.mjs'),
  'utf8',
);

describe('VS Code preview lifecycle and build boundaries', () => {
  it('releases hidden preview context and allows one editor per resource', () => {
    expect(previewProviderSource).toContain('retainContextWhenHidden: false');
    expect(previewProviderSource).toContain('supportsMultipleEditorsPerDocument: false');
  });

  it('persists only viewport state through the VS Code webview state API', () => {
    expect(previewWebviewSource).toContain('getState?(): unknown');
    expect(previewWebviewSource).toContain('setState?(state: unknown): void');
    expect(previewWebviewSource).toContain("document.querySelector<HTMLElement>('.preview-content')");
    expect(previewWebviewSource).toContain('scrollTop');
    expect(previewWebviewSource).toContain('scrollLeft');
    expect(previewWebviewSource).not.toMatch(/setState\([\s\S]{0,300}content:/);
    expect(previewWebviewSource).not.toMatch(/setState\([\s\S]{0,300}bytes:/);
  });

  it('writes production metafiles for the editor and preview bundles', () => {
    expect(esbuildSource).toContain("buildBundle('webview'");
    expect(esbuildSource).toContain("buildBundle('preview-webview'");
    expect(esbuildSource).toContain("format: 'esm'");
    expect(esbuildSource).toContain('splitting: true');
    expect(esbuildSource).toContain("chunkNames: 'editor/chunks/[name]-[hash]'");
  });
});
