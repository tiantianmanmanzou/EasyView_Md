/**
 * CellPopupEditor
 *
 * A second ProseMirror EditorView used inside the cell content popup so the
 * popup offers the exact same editing experience as editing the cell in the
 * main editor: markdown input rules (`# ` → heading, `- ` → list), keymaps,
 * undo/redo, paste (markdown / rich text / spreadsheet / images).
 *
 * The main editor's plugin stack (ExtensionManager) cannot be reused as-is —
 * many plugins are bound to main-editor UI singletons (ToolbarFloating,
 * TableGripToolbar, imageToolbar, ...). This module puts together a curated
 * whitelist of the pure/portable extension pieces.
 */

import type { Node as ProsemirrorNode } from 'prosemirror-model';
import { EditorState, TextSelection, type Plugin } from 'prosemirror-state';
import { EditorView, type NodeView, type NodeViewConstructor } from 'prosemirror-view';
import { inputRules, type InputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { dropCursor } from 'prosemirror-dropcursor';
import { history, redo, undo } from 'prosemirror-history';
import { tableEditing } from 'prosemirror-tables';

import { schema } from '../../../editor/EditorSchema';
import { handlePaste } from '../../../editor/EditorEventHandlers';
import { createPasteParser } from '../../../editor/lib/MarkdownParser';

import { KeyboardOverridesExtension } from '../../behavior/keyboard-overrides/KeyboardOverridesExtension';
import { SmartTextExtension } from '../../behavior/smart-text/SmartTextExtension';
import { MarksExtension } from '../../inline/marks/MarksExtension';
import { HeadingExtension } from '../../blocks/heading/HeadingExtension';
import { BlockquoteExtension } from '../../blocks/blockquote/BlockquoteExtension';
import { CodeBlockExtension } from '../../blocks/code-block/CodeBlockExtension';
import { HorizontalRuleExtension } from '../../blocks/horizontal-rule/HorizontalRuleExtension';
import { NoticeExtension } from '../../blocks/notice/NoticeExtension';
import { ListsExtension } from '../../blocks/lists/ListsExtension';
import { MathExtension } from '../../inline/math/MathExtension';
import { FootnotesExtension } from '../../inline/footnotes/FootnotesExtension';
import { BlockEdgeCursorExtension } from '../../behavior/block-edge-cursor/BlockEdgeCursorExtension';
import { InlineCursorExtension } from '../../behavior/inline-cursor/InlineCursorExtension';
import { MarkBoundaryExtension } from '../../behavior/mark-boundary/MarkBoundaryExtension';
import { TrailingNodeExtension } from '../../behavior/trailing-node/TrailingNodeExtension';
import { FrontmatterExtension } from '../../blocks/frontmatter/FrontmatterExtension';
import { DetailsExtension } from '../../blocks/details/DetailsExtension';
import { HtmlBlockExtension } from '../../blocks/html-block/HtmlBlockExtension';
import { VideoAudioExtension } from '../../inline/video-audio/VideoAudioExtension';

import { gripSelectionPlugin } from './GripSelectionPlugin';
import { tableKeywordsPlugin } from './TableKeywordsPlugin';
import { TableCellView } from './TableCellView';
import { CodeHighlighting } from '../../blocks/code-block/CodeBlockHighlighting';

// ─── Whitelisted editing plugins ─────────────────────────────────────────────
//
// Each entry behaves exactly like the main editor: extension keymaps are bound
// per-extension (order matters for priority), plugins are appended raw, and
// all input rules are merged into a single inputRules plugin — mirroring
// EditorExtensionManager.buildPlugins.

const EDITING_EXTENSIONS = [
  KeyboardOverridesExtension,
  ListsExtension,
  SmartTextExtension,
  MarksExtension,
  HeadingExtension,
  BlockquoteExtension,
  CodeBlockExtension,
  HorizontalRuleExtension,
  NoticeExtension,
  MathExtension,
  FootnotesExtension,
  BlockEdgeCursorExtension,
  InlineCursorExtension,
  MarkBoundaryExtension,
  TrailingNodeExtension,
] as const;

export function buildCellPopupPlugins(): Plugin[] {
  const plugins: Plugin[] = [];
  const rules: InputRule[] = [];

  for (const ExtensionClass of EDITING_EXTENSIONS) {
    const instance = new ExtensionClass();
    plugins.push(...instance.plugins(schema));
    const keymaps = instance.keymaps(schema);
    if (Object.keys(keymaps).length > 0) plugins.push(keymap(keymaps));
    rules.push(...instance.inputRules(schema));
  }

  // Table editing without the main editor's DOM-bound machinery: no column
  // resizing / grips / sticky headers / TableGripToolbar, but cell selection,
  // Tab/Shift-Tab navigation and keyword badges still work.
  plugins.push(tableEditing(), gripSelectionPlugin(), tableKeywordsPlugin());
  // Syntax highlighting for code blocks (pure decorations, module-level cache).
  plugins.push(CodeHighlighting({ name: 'code_block', lineNumbers: true }));
  if (rules.length > 0) plugins.push(inputRules({ rules }));

  // Core trio mirroring EditorCore.buildPlugins.
  plugins.push(
    history(),
    keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo }),
    dropCursor()
  );
  return plugins;
}

// ─── Whitelisted node views ──────────────────────────────────────────────────

/**
 * Lightweight table NodeView for the popup editor: static table without
 * column-resize grips, sticky headers, grips or the double-click popup.
 * Cell nodes keep their own custom views (TableCellView) for the
 * `.easyview-table-cell-content` editing area.
 */
class CellPopupTableView implements NodeView {
  readonly dom: HTMLDivElement;
  readonly contentDOM: HTMLTableSectionElement;

  constructor(node: ProsemirrorNode) {
    this.dom = document.createElement('div');
    this.dom.className = 'table-wrapper easyview-cell-popup-table-wrapper';

    const table = document.createElement('table');
    table.style.tableLayout = 'fixed';
    table.style.width = '100%';
    this.dom.appendChild(table);

    // Column widths come from the first row's cells (colwidth spans). Only
    // add a colgroup when widths were persisted on the node.
    const colgroup = document.createElement('colgroup');
    const firstRow = node.firstChild;
    if (firstRow) {
      firstRow.content.forEach((cell) => {
        const widths = cell.attrs?.colwidth as number[] | null;
        if (widths && widths.length) {
          for (const width of widths) {
            const col = document.createElement('col');
            col.style.width = `${Math.max(32, Math.round(width))}px`;
            colgroup.appendChild(col);
          }
        }
      });
    }
    if (colgroup.childElementCount > 0) table.appendChild(colgroup);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    this.contentDOM = tbody;
  }

  update(): boolean {
    // Static view; ProseMirror reconstructs on content change.
    return false;
  }

  ignoreMutation(): boolean {
    return true;
  }
}

function buildCellPopupNodeViews(): Record<string, NodeViewConstructor> {
  return {
    table: (node) => new CellPopupTableView(node),
    table_cell: (node) => new TableCellView(node),
    table_header: (node) => new TableCellView(node),
    ...new FrontmatterExtension().nodeViews,
    ...new DetailsExtension().nodeViews,
    ...new HtmlBlockExtension().nodeViews,
    ...new VideoAudioExtension().nodeViews,
  };
}

// ─── Editor instance management ─────────────────────────────────────────────

const pasteParser = createPasteParser();

let popupEditor: EditorView | null = null;

/** True while an image paste was initiated from the popup editor. */
let pendingPopupImage = false;

export function createCellPopupEditor(cellNode: ProsemirrorNode, mount: HTMLElement): EditorView | null {
  if (popupEditor) disposeCellPopupEditor();

  let content = cellNode.content;
  if (content.childCount === 0) {
    // Cells are `block+`; an empty cell pops open as a single empty paragraph.
    content = schema.nodes.doc.create(
      null,
      [schema.nodes.paragraph.create()]
    ).content;
  }
  const doc = schema.nodes.doc.create(null, content);
  const initSelection = TextSelection.atEnd(doc);
  const state = EditorState.create({
    doc,
    plugins: buildCellPopupPlugins(),
    // Always apply the caret-to-end selection; EditorState defaults to atStart
    // when it is omitted, and an empty TextSelection must be honored too.
    selection: initSelection,
  });

  const view = new EditorView(mount, {
    state,
    // Apply against the view's current state, never a captured copy —
    // EditorState is immutable, so a stale base would throw a
    // "mismatched transaction" RangeError on the second edit.
    dispatchTransaction: (tr) => {
      view.updateState(view.state.apply(tr));
    },
    handlePaste: (v, event) => handlePaste(v, event as ClipboardEvent, pasteParser),
  });
  popupEditor = view;
  return view;
}

export function disposeCellPopupEditor(): void {
  popupEditor?.destroy();
  popupEditor = null;
  pendingPopupImage = false;
}

export function getCellPopupEditor(): EditorView | null {
  return popupEditor;
}

// ─── Image paste routing ────────────────────────────────────────────────────

// The popup editor reuses the main editor's paste handler, which broadcasts an
// `inlinemd:pasteImage` window event with `detail.pos` = popup doc position;
// index.ts then posts it to the host, which saves the image file and replies
// with `imageSelected`. Mark the request so the reply is routed to the popup
// editor instead of the main editor.
window.addEventListener('inlinemd:pasteImage', () => {
  if (popupEditor) pendingPopupImage = true;
});

export function handlePopupImageSelected(src: string, originalSrc: string, pos: number): boolean {
  if (!pendingPopupImage) return false;
  pendingPopupImage = false;
  if (!popupEditor) return true; // Popup already closed — image file is saved; drop the insert.
  try {
    const image = schema.nodes.image.create({ src, originalSrc });
    popupEditor.dispatch(popupEditor.state.tr.replaceWith(pos, pos, image));
  } catch {
    // Stale position (e.g. popup content was replaced); the file is persisted.
  }
  return true;
}

// ─── Cell locating & save-back ──────────────────────────────────────────────

export interface CellNodeLocation {
  node: ProsemirrorNode;
  start: number;
}

/**
 * Locates the ProseMirror table cell node and its start position from the
 * cell's DOM element, mirroring TableView.getColumnResizeCellAtEvent.
 */
export function locateCellNode(view: EditorView, cell: HTMLElement): CellNodeLocation | null {
  if (!cell.isConnected) return null;
  try {
    const position = view.posAtDOM(cell, 0);
    const $pos = view.state.doc.resolve(position);
    for (let depth = $pos.depth; depth > 0; depth--) {
      const role = $pos.node(depth).type.spec.tableRole;
      if (role !== 'cell' && role !== 'header_cell') continue;
      const start = $pos.before(depth);
      const node = view.state.doc.nodeAt(start);
      return node ? { node, start } : null;
    }
  } catch {
    // The cell may be stale (document reloaded, table replaced).
  }
  return null;
}

/**
 * Writes the popup editor's content back into the given main-editor cell.
 * Returns true when a transaction was dispatched. Single transaction = one
 * undo step in the main editor.
 */
export function saveCellPopupContent(mainView: EditorView, cell: HTMLElement): boolean {
  if (!popupEditor) return false;
  try {
    const located = locateCellNode(mainView, cell);
    if (!located) return false;
    const { node, start } = located;

    let content = popupEditor.state.doc.content;
    if (content.childCount === 0) {
      content = schema.nodes.doc.create(
        null,
        [schema.nodes.paragraph.create()]
      ).content;
    }
    const next = node.type.create(node.attrs, content, node.marks);
    if (next.content.eq(node.content)) return false;

    const tr = mainView.state.tr.replaceRangeWith(start, start + node.nodeSize, next);
    mainView.dispatch(tr);
    return true;
  } catch (error) {
    console.warn('[EasyView] Failed to save cell popup content:', error);
    return false;
  }
}
