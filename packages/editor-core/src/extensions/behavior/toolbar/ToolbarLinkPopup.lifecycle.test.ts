/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';

import { LinkEditPopup } from './ToolbarLinkPopup';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('LinkEditPopup instance lifecycle', () => {
  it('creates independent popup instances and destroys only the selected instance', () => {
    const first = new LinkEditPopup();
    const second = new LinkEditPopup();

    expect(first).not.toBe(second);
    expect(document.querySelectorAll('.link-edit-popup')).toHaveLength(2);

    first.destroy();

    expect(document.querySelectorAll('.link-edit-popup')).toHaveLength(1);
    expect(() => first.destroy()).not.toThrow();
    expect(() => second.destroy()).not.toThrow();
    expect(document.querySelectorAll('.link-edit-popup')).toHaveLength(0);
  });
});
