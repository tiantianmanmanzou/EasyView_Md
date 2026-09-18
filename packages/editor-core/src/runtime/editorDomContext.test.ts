// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createEditorDomContext } from './editorDomContext';

describe('EditorDomContext', () => {
  it('scopes duplicate ids, overlays, and custom events to the owning root', () => {
    const firstRoot = document.createElement('section');
    const secondRoot = document.createElement('section');
    firstRoot.innerHTML = '<div id="editor"></div>';
    secondRoot.innerHTML = '<div id="editor"></div>';
    document.body.append(firstRoot, secondRoot);

    const first = createEditorDomContext(firstRoot);
    const second = createEditorDomContext(secondRoot);
    expect(first.getById('editor')).toBe(firstRoot.firstElementChild);
    expect(second.getById('editor')).toBe(secondRoot.firstElementChild);

    const listener = vi.fn();
    second.eventTarget.addEventListener('easyview-test', listener);
    first.eventTarget.dispatchEvent(new CustomEvent('easyview-test'));
    expect(listener).not.toHaveBeenCalled();

    const overlay = document.createElement('div');
    first.overlayRoot.appendChild(overlay);
    expect(firstRoot.contains(overlay)).toBe(true);
    expect(secondRoot.contains(overlay)).toBe(false);
  });
});
