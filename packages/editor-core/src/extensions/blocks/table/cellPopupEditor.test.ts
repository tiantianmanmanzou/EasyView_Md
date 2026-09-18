/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as ProsemirrorNode } from 'prosemirror-model';

import { schema } from '../../../editor/EditorSchema';
import { createParser, parseMarkdown } from '../../../editor/lib/MarkdownParser';
import {
  buildCellPopupPlugins,
  createCellPopupEditor,
  disposeCellPopupEditor,
  getCellPopupEditor,
  handlePopupImageSelected,
  locateCellNode,
  saveCellPopupContent,
} from './cellPopupEditor';

function createView(doc: ProsemirrorNode): EditorView {
  const state = EditorState.create({ doc });
  // The mount must be connected for posAtDOM/isConnected based lookups.
  const mount = document.createElement('div');
  document.body.appendChild(mount);
  return new EditorView(mount, { state });
}

function parseDoc(markdown: string): ProsemirrorNode {
  const doc = parseMarkdown(markdown, createParser());
  if (!doc) throw new Error('failed to parse markdown');
  return doc;
}

/** Finds the first table cell (td/th) node and its pos in a doc. */
function findCellNode(doc: ProsemirrorNode): { node: ProsemirrorNode; pos: number } | null {
  let found: { node: ProsemirrorNode; pos: number } | null = null;
  doc.descendants((node, pos, parent) => {
    if (found) return false;
    if (
      (node.type.name === 'table_cell' || node.type.name === 'table_header') &&
      parent?.type.name === 'table_row'
    ) {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

const SAMPLE_MD = [
  '| 编号 | 名称 |',
  '| --- | --- |',
  '| 1 | 演练场景 |',
  '| 2 | 【策略说明】参与演练 |',
].join('\n');

describe('buildCellPopupPlugins', () => {
  it('returns a non-empty plugin whitelist without throwing', () => {
    const plugins = buildCellPopupPlugins();
    expect(plugins.length).toBeGreaterThan(5);
  });
});

describe('createCellPopupEditor', () => {
  it('mounts an editor whose doc mirrors the cell content with caret at end', () => {
    const { node } = findCellNode(parseDoc(SAMPLE_MD))!;
    const mount = document.createElement('div');
    const view = createCellPopupEditor(node, mount);

    expect(view).not.toBeNull();
    expect(getCellPopupEditor()).toBe(view);
    expect(view!.state.doc.content.eq(node.content)).toBe(true);
    const init = view!.state.selection;
    expect(init.empty).toBe(true);
    // Caret is placed at the end of the content: typing appends to the last text.
    view!.dispatch(view!.state.tr.insertText('tail'));
    expect(view!.state.doc.textContent.endsWith('tail')).toBe(true);
    disposeCellPopupEditor();
  });

  it('an empty cell pops open as a single empty paragraph', () => {
    const cell = schema.nodes.table_cell.create({}, schema.nodes.paragraph.create());
    const mount = document.createElement('div');
    const view = createCellPopupEditor(cell, mount);
    expect(view).not.toBeNull();
    expect(view!.state.doc.childCount).toBe(1);
    expect(view!.state.doc.firstChild?.type.name).toBe('paragraph');
    disposeCellPopupEditor();
  });

  it('applies consecutive transactions against the current state (regression: mismatched transaction)', () => {
    const { node } = findCellNode(parseDoc(SAMPLE_MD))!;
    const view = createCellPopupEditor(node, document.createElement('div'))!;
    view.dispatch(view.state.tr.insertText('a'));
    view.dispatch(view.state.tr.insertText('b'));
    expect(view.state.doc.textContent.endsWith('ab')).toBe(true);
    disposeCellPopupEditor();
  });
});

describe('saveCellPopupContent', () => {
  it('writes edited popup content back into the cell', () => {
    const doc = parseDoc(SAMPLE_MD);
    const mainView = createView(doc);
    const { node, pos } = findCellNode(doc)!;
    const cellDom = mainView.nodeDOM(pos) as HTMLElement;

    const popupEditor = createCellPopupEditor(node, document.createElement('div'))!;
    popupEditor.dispatch(popupEditor.state.tr.insertText('edited'));
    expect(saveCellPopupContent(mainView, cellDom)).toBe(true);

    const saved = mainView.state.doc.nodeAt(pos) as ProsemirrorNode;
    expect(saved.textContent).toContain('edited');
    expect(mainView.state.doc.nodeAt(pos)).not.toBe(node);
    disposeCellPopupEditor();
  });

  it('does not dispatch a transaction when nothing changed', () => {
    const doc = parseDoc(SAMPLE_MD);
    const mainView = createView(doc);
    const { node, pos } = findCellNode(doc)!;
    const cellDom = mainView.nodeDOM(pos) as HTMLElement;
    const before = mainView.state.doc;

    createCellPopupEditor(node, document.createElement('div'));
    expect(saveCellPopupContent(mainView, cellDom)).toBe(false);
    expect(mainView.state.doc).toBe(before);
    disposeCellPopupEditor();
  });

  it('preserves cell attrs (colspan) when saving', () => {
    const cell = schema.nodes.table_cell.create(
      { colspan: 2, rowspan: 1, colwidth: [120, 180] },
      schema.nodes.paragraph.create(null, schema.text('text'))
    );
    const table = schema.nodes.table.create(null, [schema.nodes.table_row.create(null, [cell])]);
    const doc = schema.nodes.doc.create(null, [table]);
    const mainView = createView(doc);

    // Locate the cell DOM through the main view.
    let cellPos = -1;
    doc.descendants((n, p) => {
      if (cellPos >= 0) return false;
      if (n.type.name === 'table_cell') cellPos = p;
      return true;
    });
    const cellDom = mainView.nodeDOM(cellPos) as HTMLElement;

    const popupEditor = createCellPopupEditor(cell, document.createElement('div'))!;
    popupEditor.dispatch(popupEditor.state.tr.insertText('x'));
    expect(saveCellPopupContent(mainView, cellDom)).toBe(true);

    const saved = mainView.state.doc.nodeAt(cellPos) as ProsemirrorNode;
    expect(saved.attrs).toMatchObject({ colspan: 2, rowspan: 1 });
    expect(saved.attrs.colwidth).toEqual([120, 180]);
    disposeCellPopupEditor();
  });

  it('silently skips when the cell is no longer in the document', () => {
    const doc = parseDoc(SAMPLE_MD);
    const mainView = createView(doc);
    const { node } = findCellNode(doc)!;
    const detached = document.createElement('td');

    createCellPopupEditor(node, document.createElement('div'));
    expect(saveCellPopupContent(mainView, detached)).toBe(false);
    disposeCellPopupEditor();
  });
});

describe('locateCellNode', () => {
  it('finds the cell node and start position from its DOM element', () => {
    const doc = parseDoc(SAMPLE_MD);
    const mainView = createView(doc);
    const { node, pos } = findCellNode(doc)!;
    const cellDom = mainView.nodeDOM(pos) as HTMLElement;

    const located = locateCellNode(mainView, cellDom);
    expect(located).not.toBeNull();
    expect(located!.node.eq(node)).toBe(true);
  });

  it('returns null for a disconnected cell', () => {
    const doc = parseDoc(SAMPLE_MD);
    const mainView = createView(doc);
    expect(locateCellNode(mainView, document.createElement('td'))).toBeNull();
  });
});

describe('handlePopupImageSelected', () => {
  it('does nothing when no popup image paste is pending', () => {
    expect(handlePopupImageSelected('src', 'orig', 0)).toBe(false);
  });

  it('routes the image into the popup editor after a pasteImage event', () => {
    const { node } = findCellNode(parseDoc(SAMPLE_MD))!;
    createCellPopupEditor(node, document.createElement('div'));
    window.dispatchEvent(new Event('inlinemd:pasteImage'));
    const popupEditor = getCellPopupEditor()!;
    const insertPos = popupEditor.state.doc.content.size;

    expect(handlePopupImageSelected('https://example/1.png', './img/1.png', insertPos)).toBe(true);
    let hasImage = false;
    popupEditor.state.doc.descendants((child) => {
      if (child.type.name === 'image' && child.attrs.src === 'https://example/1.png') hasImage = true;
      return true;
    });
    expect(hasImage).toBe(true);
    disposeCellPopupEditor();
  });
});
