// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Schema } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import Mermaid, { MermaidRenderer, pluginKey } from './MermaidPlugin';
import { MermaidVisibilityController } from './MermaidVisibilityController';
import { MermaidRenderScheduler } from './MermaidRenderScheduler';

const mocks = vi.hoisted(() => ({
  render: vi.fn(async (_id: string, text: string) => ({ svg: `<svg><text>${text.replace(/-->/g, ' to ')}</text></svg>` })),
}));
vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: mocks.render } }));

const schema = new Schema({ nodes: {
  doc: { content: 'block+' },
  paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
  code_block: { group: 'block', content: 'text*', attrs: { language: { default: 'mermaid' } }, toDOM: () => ['pre', 0] },
  text: { group: 'inline' },
} });
const doc = (text = 'graph TD\nA') => schema.node('doc', null, [
  schema.node('code_block', { language: 'mermaid' }, schema.text(text)),
  schema.node('paragraph'),
]);
let view: EditorView | undefined;
const start = () => {
  const root = document.createElement('div');
  root.id = 'editor-scroll-area';
  document.body.append(root);
  const plugin = Mermaid({ isDark: false, openExternalLink: () => {} });
  view = new EditorView(root, { state: EditorState.create({ doc: doc(), plugins: [plugin] }) });
  return { view, plugin };
};
const rendered = async (text: string) => {
  await vi.waitFor(() => expect(view!.dom.querySelector('.mermaid-diagram-wrapper svg')?.textContent).toBe(text));
};

beforeEach(() => {
  mocks.render.mockClear();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 100, bottom: 500, left: 0, right: 1000, width: 1000, height: 400,
  } as DOMRect);
});
afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('Mermaid plugin runtime ownership', () => {
  it('keeps renderer resources out of EditorState and history snapshots', () => {
    const { view } = start();
    const decorations = pluginKey.getState(view.state).decorationSet.find();
    expect(decorations.length).toBe(2);
    expect(decorations.every((d: any) => !('renderer' in d.spec))).toBe(true);
  });

  it('releases replaced renderers instead of retaining every prior document', () => {
    const destroy = vi.spyOn(MermaidRenderer.prototype, 'destroy');
    const { view } = start();
    for (let i = 0; i < 100; i++) {
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc(`graph TD\nA${i}`).content));
    }
    expect(destroy).toHaveBeenCalledTimes(100);
    expect(view.dom.querySelectorAll('.mermaid-diagram-wrapper')).toHaveLength(1);
    view.destroy();
    expect(destroy).toHaveBeenCalledTimes(101);
  });

  it('rehydrates diagrams after state replacement recreates plugin views', async () => {
    const visibilityDispose = vi.spyOn(MermaidVisibilityController.prototype, 'dispose');
    const { view } = start();
    await rendered('graph TD\nA');
    view.updateState(EditorState.create({ doc: doc('sequenceDiagram\nA to B: hello'), plugins: view.state.plugins }));
    expect(visibilityDispose).toHaveBeenCalledTimes(1);
    await rendered('sequenceDiagram\nA to B: hello');
  });

  it('updates a reused widget when its source changes and on theme changes', async () => {
    const { view } = start();
    await rendered('graph TD\nA');
    const before = view.dom.querySelector('.mermaid-diagram-wrapper');
    view.dispatch(view.state.tr.insertText('C', 10, 11));
    await rendered('graph TD\nC');
    expect(view.dom.querySelector('.mermaid-diagram-wrapper')).toBe(before);
    const count = mocks.render.mock.calls.length;
    view.dispatch(view.state.tr.setMeta('theme', { isDark: true }));
    await vi.waitFor(() => expect(mocks.render.mock.calls.length).toBeGreaterThan(count));
  });

  it('restores an old EditorState without reviving disposed rendering objects', async () => {
    const { view } = start();
    const snapshot = view.state;
    await rendered('graph TD\nA');
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc('graph LR\nX').content));
    await rendered('graph LR\nX');
    view.updateState(snapshot);
    await rendered('graph TD\nA');
  });

  it('survives plugin-list reconfiguration and releases runtime on true teardown', async () => {
    const dispose = vi.spyOn(MermaidVisibilityController.prototype, 'dispose');
    const queueDispose = vi.spyOn(MermaidRenderScheduler.prototype, 'dispose');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { view, plugin } = start();
    await rendered('graph TD\nA');
    view.updateState(view.state.reconfigure({ plugins: [plugin, new Plugin({})] }));
    await rendered('graph TD\nA');
    view.destroy();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(queueDispose).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(2);
  });

  it('does not create rendering work for selection-only transactions', async () => {
    const { view } = start();
    await rendered('graph TD\nA');
    const count = mocks.render.mock.calls.length;
    for (let i = 0; i < 20; i++) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    expect(mocks.render.mock.calls.length).toBe(count);
  });
});
