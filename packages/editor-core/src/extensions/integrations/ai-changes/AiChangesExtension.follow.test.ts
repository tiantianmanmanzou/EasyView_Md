/** @vitest-environment jsdom */
import { expect, it, vi } from 'vitest';
import { Schema } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { AiChangesExtension, GIT_CHANGE_META } from './AiChangesExtension';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
});

it('does not show the jump toast while Follow is off and hides it when Follow turns off', () => {
  vi.useFakeTimers();
  let follow = false;
  const extension = new AiChangesExtension(() => follow);
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const view = new EditorView(mount, {
    state: EditorState.create({
      schema,
      doc: schema.node('doc', null, [schema.node('paragraph', null, schema.text('Before'))]),
      plugins: extension.plugins(schema),
    }),
  });
  try {
    const replace = (text: string): void => {
      view.dispatch(view.state.tr.replaceWith(1, view.state.doc.content.size - 1, schema.text(text))
        .setMeta('externalChange', true));
      vi.advanceTimersByTime(1000);
    };
    replace('After');
    expect(document.querySelector('.ai-changes-toast.visible')).toBeNull();

    follow = true;
    replace('Changed again');
    expect(document.querySelector('.ai-changes-toast.visible')).not.toBeNull();

    follow = false;
    extension.hideJumpToast();
    expect(document.querySelector('.ai-changes-toast.visible')).toBeNull();
    follow = true;
    extension.showCurrentJumpToast(view);
    expect(document.querySelector('.ai-changes-toast.visible')).not.toBeNull();
    follow = false;
    extension.hideJumpToast();
    replace('Changed while off');
    expect(document.querySelector('.ai-changes-toast.visible')).toBeNull();
  } finally {
    view.destroy();
    mount.remove();
    vi.useRealTimers();
  }
});

it('keeps the change navigator open while moving between changes and supports dragging and closing', () => {
  vi.useFakeTimers();
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const paragraphs = ['First', 'Second', 'Third'].map((text) => schema.node('paragraph', null, schema.text(text)));
  const doc = schema.node('doc', null, paragraphs);
  const extension = new AiChangesExtension();
  const view = new EditorView(mount, {
    state: EditorState.create({ schema, doc, plugins: extension.plugins(schema) }),
  });
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const scrolled: HTMLElement[] = [];
  HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
  try {
    const positions = [0, paragraphs[0].nodeSize, paragraphs[0].nodeSize + paragraphs[1].nodeSize];
    view.dispatch(view.state.tr.setMeta('aiChangesComplete', {
      changes: positions.map((pos, index) => ({ pos, size: paragraphs[index].nodeSize, kind: 'modified' })),
      baseFp: [],
    }));
    const toast = document.querySelector<HTMLElement>('.ai-changes-toast')!;
    const previous = toast.querySelector<HTMLButtonElement>('.ai-changes-toast-prev')!;
    const next = toast.querySelector<HTMLButtonElement>('.ai-changes-toast-next')!;
    expect(toast.classList.contains('visible')).toBe(true);
    expect(previous.disabled).toBe(true);
    expect(toast.querySelector('.ai-changes-toast-count')?.textContent).toBe('1/3');

    next.click();
    expect(scrolled).toEqual([view.nodeDOM(positions[1])]);
    expect(toast.querySelector('.ai-changes-toast-count')?.textContent).toBe('2/3');
    next.click();
    expect(next.disabled).toBe(true);
    previous.click();
    expect(scrolled.at(-1)).toBe(view.nodeDOM(positions[1]));
    expect(toast.classList.contains('visible')).toBe(true);

    toast.setPointerCapture = vi.fn();
    toast.releasePointerCapture = vi.fn();
    toast.getBoundingClientRect = () => ({ left: 100, top: 80, width: 280, height: 40 } as DOMRect);
    const pointer = (type: string, x: number, y: number) => Object.assign(
      new Event(type, { bubbles: true, cancelable: true }),
      { pointerId: 7, clientX: x, clientY: y },
    );
    toast.dispatchEvent(pointer('pointerdown', 110, 90));
    toast.dispatchEvent(pointer('pointermove', 150, 130));
    toast.dispatchEvent(pointer('pointerup', 150, 130));
    expect(toast.style.left).toBe('140px');
    expect(toast.style.top).toBe('120px');
    expect(toast.style.transform).toBe('none');

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 3000);
    expect(toast.classList.contains('visible')).toBe(true);
    toast.querySelector<HTMLButtonElement>('.ai-changes-toast-close')!.click();
    expect(toast.classList.contains('visible')).toBe(false);
  } finally {
    view.destroy();
    mount.remove();
    if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    vi.useRealTimers();
  }
});

it('uses the Git block changes already shown on the editor rail', () => {
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  const paragraphs = ['First', 'Second', 'Third'].map((text) => schema.node('paragraph', null, schema.text(text)));
  const doc = schema.node('doc', null, paragraphs);
  const extension = new AiChangesExtension();
  const view = new EditorView(mount, { state: EditorState.create({ schema, doc, plugins: extension.plugins(schema) }) });
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const scrolled: HTMLElement[] = [];
  HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
  try {
    extension.showCurrentJumpToast(view);
    const toast = document.querySelector<HTMLElement>('.ai-changes-toast.visible')!;
    expect(toast.querySelector('.ai-changes-toast-summary')?.textContent).toBe('No changes');

    const markdown = 'First\n\nSecond\n\nThird';
    view.dispatch(view.state.tr.setMeta(GIT_CHANGE_META, {
      revision: 1,
      markdown,
      lineRanges: [
        { startLine: 1, endLine: 1, kind: 'modified' },
        { startLine: 5, endLine: 5, kind: 'modified' },
      ],
    }));
    expect(toast.querySelector<HTMLElement>('.ai-changes-toast-summary')?.hidden).toBe(true);
    expect(toast.querySelector('.ai-changes-toast-count')?.textContent).toBe('1/2');
    expect(toast.querySelector('.ai-changes-toast-count')?.getAttribute('aria-label')).toBe('Git change 1 of 2');
    toast.querySelector<HTMLButtonElement>('.ai-changes-toast-next')!.click();
    expect(scrolled.at(-1)).toBe(view.nodeDOM(paragraphs[0].nodeSize + paragraphs[1].nodeSize));

    view.dispatch(view.state.tr.setMeta(GIT_CHANGE_META, { revision: 2, markdown, lineRanges: [] }));
    expect(toast.querySelector('.ai-changes-toast-summary')?.textContent).toBe('No changes');
    expect(toast.classList.contains('visible')).toBe(true);
  } finally {
    view.destroy();
    mount.remove();
    if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  }
});
