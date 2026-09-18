import { describe, expect, it } from 'vitest';
import { resolvePreviewThemeLiftTargets } from '../src/theme';

function el(id?: string, className?: string): HTMLElement {
  return { id: id || '', className: className || '' } as HTMLElement;
}

function fakeDoc(opts: { desktop?: boolean; previewRoot?: boolean; filePreviewRoot?: boolean }) {
  const html = el('html');
  const body = el('body');
  const desktop = opts.desktop ? el('desktop-root') : null;
  const filePreview = opts.filePreviewRoot ? el('file-preview-root') : null;
  const previewRoot = opts.previewRoot ? el('', 'preview-root') : null;

  return {
    documentElement: html,
    body,
    getElementById(id: string) {
      if (id === 'desktop-root') return desktop;
      if (id === 'file-preview-root') return filePreview;
      return null;
    },
    querySelector(selector: string) {
      if (selector === '.preview-root') return previewRoot;
      return null;
    },
  } as Pick<Document, 'getElementById' | 'querySelector' | 'documentElement' | 'body'>;
}

describe('resolvePreviewThemeLiftTargets', () => {
  it('keeps Desktop app shell out of preview theme lift', () => {
    const targets = resolvePreviewThemeLiftTargets(fakeDoc({
      desktop: true,
      filePreviewRoot: true,
      previewRoot: true,
    }));
    expect(targets.map((node) => node.id || node.className)).toEqual([
      'file-preview-root',
      'preview-root',
    ]);
  });

  it('lifts html/body in isolated extension preview webview', () => {
    const doc = fakeDoc({ filePreviewRoot: true });
    const targets = resolvePreviewThemeLiftTargets(doc);
    expect(targets).toContain(doc.documentElement);
    expect(targets).toContain(doc.body);
    expect(targets.some((node) => node.id === 'file-preview-root')).toBe(true);
  });
});
