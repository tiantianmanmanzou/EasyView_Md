/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { EASYVIEW_THEME_STORAGE_KEY } from '@easyview/contracts';
import { EditorAppearanceStore } from '@easyview/editor-core';
import { applyDesktopProductAppearance } from './productThemeControl';

afterEach(() => {
  localStorage.clear();
  document.body.className = '';
  document.body.removeAttribute('style');
  document.body.removeAttribute('data-mdpre-accent');
  document.body.removeAttribute('data-easyview-theme');
  document.documentElement.removeAttribute('data-easyview-theme');
  document.documentElement.removeAttribute('data-theme');
});

describe('Desktop product appearance', () => {
  it('applies mode, depth and accent to the shell without a Markdown editor', () => {
    const appearance = new EditorAppearanceStore(localStorage);
    const subscription = appearance.subscribe((state) => applyDesktopProductAppearance(state, document));
    appearance.setAccent('green');
    appearance.setDepth(0.8);
    appearance.setMode('dark');

    expect(document.body.dataset.mdpreAccent).toBe('green');
    expect(document.body.classList.contains('mdpre-dark')).toBe(true);
    expect(document.documentElement.dataset.easyviewTheme).toBe('dark');
    expect(document.body.style.getPropertyValue('--vscode-editor-background')).not.toBe('#1e1e1e');
    expect(new EditorAppearanceStore(localStorage).state).toEqual({ mode: 'dark', depth: 0.8, accent: 'green' });
    subscription.unsubscribe();
  });

  it('cycles and persists the product theme without changing file theme overrides', () => {
    localStorage.setItem('easyview.preview.fileTheme:notes.txt', 'gray');
    const appearance = new EditorAppearanceStore(localStorage);
    appearance.cycleMode();
    expect(appearance.state.mode).toBe('gray');
    appearance.cycleMode();
    expect(appearance.state.mode).toBe('dark');
    appearance.cycleMode();
    expect(appearance.state.mode).toBe('light');
    expect(localStorage.getItem(EASYVIEW_THEME_STORAGE_KEY)).toBe('light');
    expect(localStorage.getItem('easyview.preview.fileTheme:notes.txt')).toBe('gray');
  });
});
