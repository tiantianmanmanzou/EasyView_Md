/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { schema } from '../../../editor/EditorSchema';
import { HeadingExtension, type HeadingExtensionOptions } from './HeadingExtension';

function createHeadingView(options: HeadingExtensionOptions = {}): { view: EditorView; mount: HTMLDivElement } {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const doc = schema.node('doc', null, [schema.node('heading', { level: 1 }, schema.text('Heading'))]);
  const state = EditorState.create({ schema, doc, plugins: new HeadingExtension(options).plugins(schema) });
  return { view: new EditorView(mount, { state }), mount };
}

function dispatchMouseDown(mount: HTMLDivElement, selector: string): void {
  const button = mount.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`Missing heading widget: ${selector}`);
  button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('HeadingExtension instance callbacks', () => {
  it('keeps toast callbacks isolated between simultaneous editor instances', async () => {
    const clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboardWriteText } });
    const firstToast = vi.fn();
    const secondToast = vi.fn();
    const first = createHeadingView({ document, onToast: firstToast });
    const second = createHeadingView({ document, onToast: secondToast });

    try {
      dispatchMouseDown(first.mount, '.heading-anchor');
      await Promise.resolve();
      expect(firstToast).toHaveBeenCalledWith('Link copied');
      expect(secondToast).not.toHaveBeenCalled();

      dispatchMouseDown(second.mount, '.heading-anchor');
      await Promise.resolve();
      expect(secondToast).toHaveBeenCalledWith('Link copied');
      expect(firstToast).toHaveBeenCalledTimes(1);
    } finally {
      first.view.destroy();
      second.view.destroy();
    }
  });

  it('routes outline copy to the owning extension instance', () => {
    const firstCopy = vi.fn();
    const secondCopy = vi.fn();
    const first = createHeadingView({ document, onCopyOutlinePath: firstCopy });
    const second = createHeadingView({ document, onCopyOutlinePath: secondCopy });

    try {
      dispatchMouseDown(first.mount, '.heading-copy-outline');
      expect(firstCopy).toHaveBeenCalledWith(0);
      expect(secondCopy).not.toHaveBeenCalled();
    } finally {
      first.view.destroy();
      second.view.destroy();
    }
  });
});
