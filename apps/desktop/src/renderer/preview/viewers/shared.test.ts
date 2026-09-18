/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest';
import { readPreviewAppearance, themedHtmlDocument, themedSvgDocument } from './shared';

describe('preview appearance', () => {
  beforeEach(() => {
    document.body.className = '';
    document.body.removeAttribute('data-mdpre-accent');
    document.body.removeAttribute('data-easyview-theme');
    document.documentElement.removeAttribute('data-easyview-theme');
    document.body.removeAttribute('style');
  });

  it('derives preview background and accent text from the active editor theme', () => {
    document.documentElement.dataset.easyviewTheme = 'dark';
    document.body.dataset.easyviewTheme = 'dark';
    document.body.style.setProperty('--vscode-editor-background', 'rgb(30, 30, 30)');
    document.body.style.setProperty('--vscode-editor-foreground', 'rgb(212, 212, 212)');
    document.body.style.setProperty('--vscode-editorWidget-background', 'rgb(37, 37, 38)');
    document.body.style.setProperty('--mdpre-accent', 'rgb(74, 222, 128)');
    document.body.style.setProperty('--mdpre-accent-text', 'rgb(134, 239, 172)');
    document.body.dataset.mdpreAccent = 'green';

    expect(readPreviewAppearance()).toEqual({
      theme: 'dark',
      mode: 'dark',
      background: 'rgb(30, 30, 30)',
      panelBackground: 'rgb(37, 37, 38)',
      foreground: 'rgb(212, 212, 212)',
      textColor: 'rgb(134, 239, 172)',
      accent: 'rgb(74, 222, 128)',
    });
  });

  it('injects the active colors into isolated HTML and SVG previews', () => {
    const appearance = {
      theme: 'light' as const,
      mode: 'light' as const,
      background: 'rgb(255, 255, 255)',
      panelBackground: 'rgb(246, 248, 250)',
      foreground: 'rgb(31, 35, 40)',
      textColor: 'rgb(29, 78, 216)',
      accent: 'rgb(37, 99, 235)',
    };

    expect(themedHtmlDocument('<html><head></head><body><p>text</p></body></html>', appearance))
      .toContain('color:rgb(29, 78, 216)!important');
    expect(themedSvgDocument('<svg><text>text</text></svg>', appearance))
      .toContain('fill:rgb(29, 78, 216)!important');
  });
});
