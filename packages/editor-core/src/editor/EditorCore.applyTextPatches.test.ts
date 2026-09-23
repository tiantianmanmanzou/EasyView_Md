// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { undoDepth } from 'prosemirror-history';
import { EditorCore } from './EditorCore';

const editors: EditorCore[] = [];
afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
  document.body.replaceChildren();
});

function createEditor(markdown: string): EditorCore {
  const editor = new EditorCore({ extensions: [] });
  const root = document.createElement('div');
  document.body.append(root);
  editor.init(root);
  editor.setContent(markdown);
  editors.push(editor);
  return editor;
}
function patch(markdown: string, needle: string, insert: string) {
  const from = markdown.indexOf(needle);
  if (from < 0) throw new Error(`Missing needle: ${needle} in ${markdown}`);
  return { from, to: from + needle.length, insert };
}

describe('EditorCore.applyTextPatches', () => {
  it.each([
    ['paragraph', 'A paragraph.', 'paragraph', 'changed paragraph'],
    ['heading', '# Heading', 'Heading', 'Changed heading'],
    ['blockquote', '> quoted text', 'quoted text', 'changed text'],
    ['list', '- one\n- two', 'one', 'changed'],
    ['markdown table', '| A | B |\n|---|---|\n| 1 | 2 |', '1', '9'],
    ['HTML table', '<table>\n<tr><td>x</td></tr>\n</table>', 'x', 'y'],
  ])(
    'locally applies a semantic-safe %s edit',
    (_kind, source, needle, insert) => {
      const editor = createEditor(source);
      const before = editor.currentContent;
      expect(editor.applyTextPatches([patch(before, needle, insert)])).toBe(
        true,
      );
      if (_kind === 'HTML table')
        expect(editor.view!.state.doc.textContent).toContain(insert);
      else expect(editor.getMarkdown()).toContain(insert);
      expect(undoDepth(editor.view!.state)).toBe(0);
    },
  );

  it('preserves table style metadata while applying a local table cell patch', () => {
    const source = [
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '<!-- easyview:table-meta',
      '{"version":1,"tables":[{"shape":[2],"cells":[{"row":0,"cell":0,"colwidth":[240]}]}]}',
      '-->',
    ].join('\n');
    const editor = createEditor(source);
    const before =
      editor.view!.state.doc.firstChild!.firstChild!.firstChild!.attrs.colwidth;
    expect(
      editor.applyTextPatches([patch(editor.currentContent, 'A', 'C')]),
    ).toBe(true);
    expect(
      editor.view!.state.doc.firstChild!.firstChild!.firstChild!.attrs.colwidth,
    ).toEqual(before);
    expect(undoDepth(editor.view!.state)).toBe(0);
  });

  it.each([
    ['---\ntitle: Demo\n---\n\nBody', 'Demo'],
    ['[ref]: https://example.com\n\nBody', 'example'],
    ['[^note]: footnote\n\nBody', 'footnote'],
    ['```mermaid\ngraph TD\n```', 'graph'],
    [
      '<!-- easyview:table-meta\n{"version":1,"tables":[]}\n-->\n\n| A | B |\n|---|---|\n| 1 | 2 |',
      'A',
    ],
  ])('rejects document-scope or unsafe construct edits', (source, needle) => {
    const editor = createEditor(source);
    const before = editor.currentContent;
    expect(editor.applyTextPatches([patch(before, needle, 'X')])).toBe(false);
    expect(undoDepth(editor.view!.state)).toBe(0);
  });
});
