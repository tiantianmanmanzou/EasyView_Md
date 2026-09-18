/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';

import { ImageToolbar } from './ImageToolbar';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ImageToolbar instance lifecycle', () => {
  it('creates independent toolbar instances and destroys only the selected instance', () => {
    const first = new ImageToolbar();
    const second = new ImageToolbar();

    expect(first).not.toBe(second);
    expect(document.querySelectorAll('.image-toolbar')).toHaveLength(2);

    first.destroy();

    expect(document.querySelectorAll('.image-toolbar')).toHaveLength(1);
    expect(() => first.destroy()).not.toThrow();
    expect(() => second.destroy()).not.toThrow();
    expect(document.querySelectorAll('.image-toolbar')).toHaveLength(0);
  });
});
