/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';
import type { EditorView } from 'prosemirror-view';

import { createToolbarButtons } from './ToolbarButtons';

describe('createToolbarButtons', () => {
  it('binds the link command to the supplied popup instance', () => {
    const firstToggle = vi.fn();
    const secondToggle = vi.fn();
    const firstButtons = createToolbarButtons(firstToggle);
    const secondButtons = createToolbarButtons(secondToggle);
    const firstLink = firstButtons.find((button) => button.id === 'link');
    const secondLink = secondButtons.find((button) => button.id === 'link');
    const view = {} as EditorView;

    expect(firstLink).toBeDefined();
    expect(secondLink).toBeDefined();

    firstLink!.command({} as never, undefined, view);
    secondLink!.command({} as never, undefined, view);

    expect(firstToggle).toHaveBeenCalledOnce();
    expect(firstToggle).toHaveBeenCalledWith(view);
    expect(secondToggle).toHaveBeenCalledOnce();
    expect(secondToggle).toHaveBeenCalledWith(view);
  });
});
