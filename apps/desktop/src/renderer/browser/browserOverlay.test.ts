/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { isBrowserSurfaceObscured } from './browserOverlay';

describe('browser overlay', () => {
  it('hides the guest view while a modal, menu, or the welcome page covers the editor', () => {
    document.body.innerHTML = '<div class="easyview-terminal-modal"></div>';
    expect(isBrowserSurfaceObscured(document)).toBe(false);
    document.querySelector('.easyview-terminal-modal')!.classList.add('visible');
    expect(isBrowserSurfaceObscured(document)).toBe(true);
    document.body.innerHTML = '<div class="desktop-command-palette is-open"></div>';
    expect(isBrowserSurfaceObscured(document)).toBe(true);
    document.body.innerHTML = '';
    document.body.classList.add('desktop-welcome-active');
    expect(isBrowserSurfaceObscured(document)).toBe(true);
  });
});
