/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { schema } from '../../../editor/EditorSchema';
import { FindAndReplacePanel } from './FindReplacePanel';

function createPanel(): { panel: FindAndReplacePanel; view: EditorView; root: HTMLElement } {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, schema.text('hello world')),
  ]);
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const view = new EditorView(mount, { state: EditorState.create({ schema, doc }) });
  return { panel: new FindAndReplacePanel(view), view, root: mount };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  document.body.replaceChildren();
});

describe('FindAndReplacePanel layout', () => {
  it('opens as a compact rounded card with replace expanded and equal input widths', () => {
    const { panel, view } = createPanel();
    panel.open();

    const root = document.querySelector<HTMLElement>('.find-replace-panel');
    const replaceRow = document.querySelector<HTMLElement>('.find-replace-row-replace');
    const groups = [...document.querySelectorAll<HTMLElement>('.find-replace-input-group')];
    const inputs = [...document.querySelectorAll<HTMLInputElement>('.find-replace-input')];

    expect(root?.classList.contains('open')).toBe(true);
    expect(replaceRow?.style.display).not.toBe('none');
    expect(document.querySelector('.find-replace-toggle-btn')?.textContent).toBe('▼');
    expect(groups).toHaveLength(2);
    expect(inputs.map((input) => input.placeholder)).toEqual(['Find', 'Replace']);
    expect(groups[0]?.style.width || getComputedStyle(groups[0]).width).toBeTruthy();
    expect(getComputedStyle(groups[0]).width).toBe(getComputedStyle(groups[1]).width);
    expect(getComputedStyle(root!).borderTopLeftRadius).not.toBe('0px');

    inputs[0].focus();
    const focused = getComputedStyle(inputs[0]);
    expect(focused.outlineStyle === 'none' || focused.outlineWidth === '0px').toBe(true);
    expect(focused.borderStyle === 'none' || focused.borderWidth === '0px').toBe(true);
    panel.destroy();
    view.destroy();
  });

  it('remembers the last dragged position', () => {
    const first = createPanel();
    first.panel.open();
    const root = document.querySelector<HTMLElement>('.find-replace-panel');
    expect(root).toBeTruthy();

    root!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 20 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 160, clientY: 90 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 160, clientY: 90 }));

    const saved = JSON.parse(window.localStorage.getItem('easyview-find-replace-position') ?? 'null') as { left: number; top: number };
    expect(saved.left).toBeGreaterThan(8);
    expect(saved.top).toBeGreaterThan(8);

    first.panel.destroy();
    first.view.destroy();

    const second = createPanel();
    second.panel.open();
    const next = document.querySelector<HTMLElement>('.find-replace-panel');
    expect(next?.style.left).toBe(`${saved.left}px`);
    expect(next?.style.top).toBe(`${saved.top}px`);
    second.panel.destroy();
    second.view.destroy();
  });

  it('does not start a drag from the find input', () => {
    const { panel, view } = createPanel();
    panel.open();
    const input = document.querySelector<HTMLInputElement>('.find-replace-input');
    const root = document.querySelector<HTMLElement>('.find-replace-panel');
    const leftBefore = root?.style.left;
    input!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 200, clientY: 200 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(root?.style.left).toBe(leftBefore);
    expect(window.localStorage.getItem('easyview-find-replace-position')).toBeNull();
    panel.destroy();
    view.destroy();
  });
});
