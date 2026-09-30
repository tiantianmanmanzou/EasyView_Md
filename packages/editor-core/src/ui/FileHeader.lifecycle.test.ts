/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileHeader } from './FileHeader';

const DEFAULT_CAPABILITIES = {
  sourceMode: 'native' as const,
  git: true,
  terminal: true,
  aiCommitMessage: true,
  aiChat: true,
  documentConversion: true,
  shortcutPersistence: true,
};

function createHeader(capabilities: Partial<typeof DEFAULT_CAPABILITIES> = {}) {
  return createFileHeader({
    postMessage: vi.fn(),
    getState: () => ({
      isFullWidth: true,
      isTocVisible: true,
      isTableWrap: false,
      currentContent: '',
    }),
    setState: vi.fn(),
    onSettingsChange: vi.fn(),
    capabilities: { ...DEFAULT_CAPABILITIES, ...capabilities },
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('FileHeader lifecycle', () => {
  it('destroy removes the header, modal roots, and document listeners idempotently', () => {
    const header = createHeader();
    document.body.appendChild(header.el);

    header.openCommitModal();
    expect(document.querySelector('.file-header-commit-backdrop')).not.toBeNull();
    expect(document.querySelector('.file-header-shortcuts-backdrop')).not.toBeNull();

    header.destroy();
    header.destroy();

    expect(document.querySelector('.file-header-bar')).toBeNull();
    expect(document.querySelector('.file-header-commit-backdrop')).toBeNull();
    expect(document.querySelector('.file-header-shortcuts-backdrop')).toBeNull();
  });

  it('removes active pointer listeners after a depth drag starts', () => {
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const header = createHeader();
    document.body.appendChild(header.el);

    const depthTrack = document.querySelector('.file-header-theme-depth-track') as HTMLElement | null;
    expect(depthTrack).not.toBeNull();
    depthTrack?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: 0 }));

    header.destroy();

    expect(removeListener).toHaveBeenCalledWith('pointermove', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('pointerup', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('pointercancel', expect.any(Function));
    removeListener.mockRestore();
  });

  it('hides Git and terminal controls when the host does not provide them', () => {
    const header = createHeader({ git: false, terminal: false });
    document.body.appendChild(header.el);

    expect(header.el.querySelector('[data-action="stageFile"]')).toBeNull();
    expect(header.el.querySelector('[data-action="commitFile"]')).toBeNull();
    expect(header.el.querySelector('[data-action="toggleViewChanges"]')).toBeNull();
    expect(header.el.querySelector('[data-action="toggleTerminal"]')).toBeNull();
  });

  it('opens a manual commit dialog without requesting AI generation when unavailable', () => {
    const commitHandler = vi.fn();
    const commitConfirmHandler = vi.fn();
    const header = createHeader({ aiCommitMessage: false });
    header.setCommitHandler(commitHandler);
    header.setCommitConfirmHandler(commitConfirmHandler);
    document.body.appendChild(header.el);

    (header.el.querySelector('[data-action="commitFile"]') as HTMLButtonElement).click();

    expect(commitHandler).not.toHaveBeenCalled();
    expect(document.querySelector('.file-header-commit-loading.open')).toBeNull();

    const textarea = document.querySelector('.file-header-commit-textarea') as HTMLTextAreaElement;
    textarea.value = 'Manual commit message';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    (document.querySelector('[data-action="commit"]') as HTMLButtonElement).click();

    expect(commitConfirmHandler).toHaveBeenCalledWith('Manual commit message');
  });

  it('keeps openWithEasyView independent and hides it without shortcut persistence', () => {
    const header = createHeader({ shortcutPersistence: false });
    document.body.appendChild(header.el);

    const settingsButton = Array.from(header.el.querySelectorAll('button'))
      .find((button) => button.title === 'Configure toolbar shortcuts') as HTMLButtonElement;
    settingsButton.click();

    expect(document.querySelector('[data-action="openWithEasyView"]')).toBeNull();
    expect(document.querySelector('[data-action="openSourceMode"]')).not.toBeNull();
  });

  it('toggles external-follow scroll on and off from the toolbar button', () => {
    const handler = vi.fn();
    const header = createHeader();
    header.setExternalFollowHandler(handler);
    document.body.appendChild(header.el);
    const toggle = header.el.querySelector('[data-action="toggleExternalFollow"]') as HTMLButtonElement;

    expect(toggle).not.toBeNull();
    const initiallyOn = toggle.getAttribute('aria-pressed') === 'true';
    expect(handler).toHaveBeenLastCalledWith(initiallyOn);

    toggle.click();
    expect(toggle.getAttribute('aria-pressed')).toBe(initiallyOn ? 'false' : 'true');
    expect(toggle.classList.contains('active')).toBe(!initiallyOn);
    expect(handler).toHaveBeenLastCalledWith(!initiallyOn);

    toggle.click();
    expect(toggle.getAttribute('aria-pressed')).toBe(initiallyOn ? 'true' : 'false');
    expect(toggle.classList.contains('active')).toBe(initiallyOn);
    expect(handler).toHaveBeenLastCalledWith(initiallyOn);
  });

  it('includes change view in toolbar shortcut settings', () => {
    const header = createHeader();
    document.body.appendChild(header.el);

    const settingsButton = Array.from(header.el.querySelectorAll('button'))
      .find((button) => button.title === 'Configure toolbar shortcuts') as HTMLButtonElement;
    settingsButton.click();

    const input = document.querySelector('[data-action="toggleViewChanges"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value === 'Alt+V' || input.value === 'Option+V').toBe(true);
  });

  it('disables change view until git reports uncommitted changes', () => {
    const handler = vi.fn();
    const header = createHeader();
    header.setViewChangesHandler(handler);
    document.body.appendChild(header.el);
    const toggle = header.el.querySelector('[data-action="toggleViewChanges"]') as HTMLButtonElement;

    expect(toggle.disabled).toBe(true);
    toggle.click();
    expect(handler).not.toHaveBeenCalled();

    header.syncViewChangesState(false, true);
    expect(toggle.disabled).toBe(false);
    toggle.click();
    expect(handler).toHaveBeenCalledTimes(1);

    header.syncViewChangesState(true, false);
    expect(toggle.disabled).toBe(true);
    expect(toggle.classList.contains('active')).toBe(false);
    expect(toggle.title).toContain('no uncommitted changes');
    toggle.click();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not link openWithEasyView and openSourceMode shortcuts', () => {
    const header = createHeader();
    document.body.appendChild(header.el);

    const settingsButton = Array.from(header.el.querySelectorAll('button'))
      .find((button) => button.title === 'Configure toolbar shortcuts') as HTMLButtonElement;
    settingsButton.click();

    const openWithEasyView = document.querySelector('[data-action="openWithEasyView"]') as HTMLInputElement;
    const openSourceMode = document.querySelector('[data-action="openSourceMode"]') as HTMLInputElement;
    expect(openWithEasyView.value).not.toBe(openSourceMode.value);

    openWithEasyView.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      key: 'Z',
      code: 'KeyZ',
      altKey: true,
    }));
    expect(openWithEasyView.value).toBe('Alt+Z');
    expect(openSourceMode.value).toBe('Alt+Q');
  });

  it('hides DOCX conversion when document conversion is unavailable', () => {
    const header = createHeader({ documentConversion: false });
    document.body.appendChild(header.el);

    const exportButton = Array.from(header.el.querySelectorAll('button'))
      .find((button) => button.title === 'Export') as HTMLButtonElement;
    exportButton.click();

    expect(document.querySelector('[data-action="exportDocx"]')).toBeNull();
    expect(document.querySelector('.file-header-dropdown')?.textContent).toContain('Export HTML');
    expect(document.querySelector('.file-header-dropdown')?.textContent).toContain('Export PDF');
  });

});