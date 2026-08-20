/**
 * Enter-key behavior for nested tables inside HTML table cells.
 *
 * When the caret is at the bottom edge of a nested table (or on the block
 * edge immediately after it), Enter should create a paragraph below the nested
 * table in the host cell — not a new row inside the nested table.
 */

import type { Node as ProsemirrorNode, ResolvedPos } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { BlockEdgeCursor } from '../../behavior/block-edge-cursor/BlockEdgeCursor';

interface NestedTableHostContext {
  hostCellDepth: number;
  nestedTableDepth: number;
  tableEndPos: number;
}

function isTableCellRole(role: unknown): boolean {
  return role === 'cell' || role === 'header_cell';
}

/** Nested table = table whose parent is a cell inside another table. */
export function findNestedTableHostContext($from: ResolvedPos): NestedTableHostContext | null {
  let nestedTableDepth = -1;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.spec.tableRole === 'table') {
      nestedTableDepth = depth;
      break;
    }
  }
  if (nestedTableDepth <= 0) return null;

  const hostCellDepth = nestedTableDepth - 1;
  if (hostCellDepth <= 0) return null;
  if (!isTableCellRole($from.node(hostCellDepth).type.spec.tableRole)) return null;

  let outerTableDepth = -1;
  for (let depth = hostCellDepth - 1; depth > 0; depth--) {
    if ($from.node(depth).type.spec.tableRole === 'table') {
      outerTableDepth = depth;
      break;
    }
  }
  if (outerTableDepth < 0) return null;

  const nestedTable = $from.node(nestedTableDepth);
  const tableStart = $from.before(nestedTableDepth);
  return {
    hostCellDepth,
    nestedTableDepth,
    tableEndPos: tableStart + nestedTable.nodeSize,
  };
}

/** True when the caret is in the last cell of the last row at end of its text block. */
export function isAtNestedTableBottomExit($from: ResolvedPos, nestedTableDepth: number): boolean {
  if (!$from.parent.isTextblock) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;

  let rowDepth = -1;
  let cellDepth = -1;
  for (let depth = nestedTableDepth + 1; depth <= $from.depth; depth++) {
    const role = $from.node(depth).type.spec.tableRole;
    if (role === 'row') rowDepth = depth;
    if (isTableCellRole(role)) cellDepth = depth;
  }
  if (rowDepth < 0 || cellDepth < 0) return false;

  const table = $from.node(nestedTableDepth);
  const row = $from.node(rowDepth);
  if (row !== table.lastChild) return false;

  const cellIndex = $from.index(rowDepth);
  if (cellIndex !== row.childCount - 1) return false;

  return true;
}

export function insertParagraphAfterNestedTable(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  insertPos: number,
): boolean {
  const paragraph = state.schema.nodes.paragraph.create();
  if (dispatch) {
    const tr = state.tr.replaceWith(insertPos, insertPos, paragraph);
    tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 1)));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

export function handleNestedTableEnter(view: EditorView): boolean {
  const { state, dispatch } = view;
  const { schema, selection } = state;

  if (selection instanceof BlockEdgeCursor) {
    const { $from } = selection;
    const nodeBefore = $from.nodeBefore;
    const nodeAfter = $from.nodeAfter;
    if (nodeBefore?.type.spec.tableRole !== 'table') return false;
    if (!isTableCellRole($from.parent.type.spec.tableRole)) return false;

    if (nodeAfter?.type === schema.nodes.paragraph && nodeAfter.content.size === 0) {
      if (dispatch) {
        dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve($from.pos + 1))));
      }
      return true;
    }

    return insertParagraphAfterNestedTable(state, dispatch, $from.pos);
  }

  if (!(selection instanceof TextSelection) || !selection.empty) return false;

  const { $from } = selection;
  const context = findNestedTableHostContext($from);
  if (!context) return false;
  if (!isAtNestedTableBottomExit($from, context.nestedTableDepth)) return false;

  const hostCell = $from.node(context.hostCellDepth);
  let tableIndex = -1;
  hostCell.forEach((child, _offset, index) => {
    if (tableIndex < 0 && child.type.spec.tableRole === 'table') {
      tableIndex = index;
    }
  });
  if (tableIndex < 0) return false;

  if (tableIndex + 1 < hostCell.childCount) {
    const afterTable = hostCell.child(tableIndex + 1);
    if (afterTable?.type === schema.nodes.paragraph && afterTable.content.size === 0) {
      if (dispatch) {
        const paragraphStart = context.tableEndPos + 1;
        dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(paragraphStart + 1))));
      }
      return true;
    }
  }

  return insertParagraphAfterNestedTable(state, dispatch, context.tableEndPos);
}
