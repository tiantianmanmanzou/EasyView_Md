/**
 * Toolbar helper functions and shared types.
 */

import { EditorView } from 'prosemirror-view';
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import { wrapIn } from 'prosemirror-commands';
import { liftTarget, findWrapping } from 'prosemirror-transform';
import { NodeRange } from 'prosemirror-model';
import { wrapInList, liftListItem } from 'prosemirror-schema-list';
import { CellSelection } from 'prosemirror-tables';
import { schema } from './EditorSchema';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToolbarButton {
  id: string;
  icon: string;
  title: string;
  command: (state: EditorState, dispatch?: any, view?: EditorView) => boolean;
  isActive?: (state: EditorState) => boolean;
  /** If provided, controls whether the button is shown (return false to hide) */
  visible?: (state: EditorState) => boolean;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Chain multiple commands sequentially
 * Collects steps from all commands into a single transaction
 */
export function chainTransactions(...commands: (Command | undefined)[]): Command {
  return (state, dispatch): boolean => {
    if (!dispatch) {
      return commands.every(cmd => cmd ? cmd(state) : true);
    }

    const tr = state.tr;
    let newState = state;

    for (const command of commands) {
      if (!command) continue;

      // Collect steps from this command into our transaction
      const result = command(newState, (commandTr) => {
        // Add all steps and mappings from the command to our transaction
        for (let i = 0; i < commandTr.steps.length; i++) {
          tr.step(commandTr.steps[i]);
        }
        for (let i = 0; i < commandTr.mapping.maps.length; i++) {
          tr.mapping.appendMap(commandTr.mapping.maps[i]);
        }
      });

      if (!result) {
        return false;
      }

      // Update state with the accumulated transaction
      newState = state.apply(tr);
    }

    // Dispatch the combined transaction once
    dispatch(tr);
    return true;
  };
}

/**
 * Clear nodes - lift selected content out of wrapping nodes (from Outline)
 */
export function clearNodes(): Command {
  return (state, dispatch) => {
    const { tr, selection } = state;
    const { ranges } = selection;

    if (!dispatch) {
      return true;
    }

    ranges.forEach(({ $from, $to }) => {
      state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
        if (node.type.isText) {
          return;
        }

        const { doc, mapping } = tr;
        const $mappedFrom = doc.resolve(mapping.map(pos));
        const $mappedTo = doc.resolve(mapping.map(pos + node.nodeSize));
        const nodeRange = $mappedFrom.blockRange($mappedTo);

        if (!nodeRange) {
          return;
        }

        const targetLiftDepth = liftTarget(nodeRange);

        if (node.type.isTextblock) {
          const { defaultType } = $mappedFrom.parent.contentMatchAt(
            $mappedFrom.index()
          );
          if (defaultType) {
            tr.setNodeMarkup(nodeRange.start, defaultType);
          }
        }

        if (targetLiftDepth || targetLiftDepth === 0) {
          tr.lift(nodeRange, targetLiftDepth);
        }
      });
    });

    dispatch(tr);
    return true;
  };
}

/**
 * Smart wrapIn:
 * - CellSelection (table): toggle wrap/unwrap for each selected cell
 * - Entire list selected: wrap the whole list
 * - Otherwise: standard wrapIn
 */
export function wrapInBlockSmart(nodeType: any, attrs?: any): Command {
  return (state, dispatch) => {
    const { selection } = state;

    // ── CellSelection: wrap/unwrap each selected cell ──
    if (selection instanceof CellSelection) {
      if (dispatch) {
        const tr = state.tr;
        const cells: { pos: number; node: any }[] = [];
        (selection as any).forEachCell((node: any, pos: number) => {
          cells.push({ pos, node });
        });

        const wrapperTypes = [schema.nodes.blockquote, schema.nodes.notice];
        const targetAttrs = JSON.stringify(attrs || nodeType.defaultAttrs);

        // Check if ALL cells already have the exact same wrapper → toggle off
        const allSame = cells.every(({ node: cellNode }) => {
          const fc = cellNode.firstChild;
          return fc && fc.type === nodeType && JSON.stringify(fc.attrs) === targetAttrs;
        });

        // Process in reverse to preserve positions
        for (let i = cells.length - 1; i >= 0; i--) {
          const { pos, node: cellNode } = cells[i];
          const contentStart = tr.mapping.map(pos + 1);
          const contentEnd = tr.mapping.map(pos + 1 + cellNode.content.size);
          const firstChild = cellNode.firstChild;
          const existingWrapper = firstChild && wrapperTypes.includes(firstChild.type)
            ? firstChild : null;

          if (allSame) {
            // Unwrap all
            tr.replaceWith(contentStart, contentEnd, existingWrapper!.content);
          } else if (existingWrapper) {
            // Replace existing wrapper with new type
            const wrapped = nodeType.create(attrs, existingWrapper.content);
            tr.replaceWith(contentStart, contentEnd, wrapped);
          } else {
            // No wrapper — wrap cell content
            const wrapped = nodeType.create(attrs, cellNode.content);
            tr.replaceWith(contentStart, contentEnd, wrapped);
          }
        }

        dispatch(tr);
      }
      return true;
    }

    // ── List: if entire list selected, wrap the whole list ──
    const { $from, $to } = selection;

    const listTypes = [
      schema.nodes.bullet_list,
      schema.nodes.ordered_list,
      schema.nodes.checkbox_list,
    ];

    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (listTypes.includes(node.type)) {
        const listStart = $from.before(d);
        const listEnd = $from.after(d);

        // Check: $from is in the first item and $to is in the last item
        const firstItemStart = listStart + 1; // after list open
        const lastItemEnd = listEnd - 1;      // before list close
        const inFirstItem = $from.pos < firstItemStart + node.firstChild!.nodeSize;
        const inLastItem = $to.pos > lastItemEnd - node.lastChild!.nodeSize;

        if (inFirstItem && inLastItem) {
          if (dispatch) {
            // Use tr.wrap() instead of replaceWith to preserve selection mapping
            const range = new NodeRange($from, $to, d - 1);
            const wrapping = findWrapping(range, nodeType, attrs);
            if (wrapping) {
              dispatch(state.tr.wrap(range, wrapping));
            }
          }
          return true;
        }

        // Partial: wrap each selected list item individually
        if (dispatch) {
          const tr = state.tr;
          const itemType = node.type === schema.nodes.checkbox_list
            ? schema.nodes.checkbox_item : schema.nodes.list_item;
          const wrapperTypes = [schema.nodes.blockquote, schema.nodes.notice];
          const items: { pos: number; node: any }[] = [];

          // Collect list items that overlap with the selection
          node.forEach((child: any, offset: number) => {
            const itemPos = listStart + 1 + offset;
            const itemEnd = itemPos + child.nodeSize;
            if (child.type === itemType && itemEnd > $from.pos && itemPos < $to.pos) {
              items.push({ pos: itemPos, node: child });
            }
          });

          const targetAttrs = JSON.stringify(attrs || nodeType.defaultAttrs);

          // Toggle off only if ALL selected items have the exact same wrapper
          const allSame = items.every(({ node: itemNode }) => {
            const fc = itemNode.firstChild;
            return fc && fc.type === nodeType && JSON.stringify(fc.attrs) === targetAttrs;
          });

          // Process in reverse to preserve positions
          for (let i = items.length - 1; i >= 0; i--) {
            const { pos: itemPos, node: itemNode } = items[i];
            const contentStart = tr.mapping.map(itemPos + 1);
            const contentEnd = tr.mapping.map(itemPos + 1 + itemNode.content.size);
            const firstChild = itemNode.firstChild;
            const existingWrapper = firstChild && wrapperTypes.includes(firstChild.type)
              ? firstChild : null;

            if (allSame) {
              tr.replaceWith(contentStart, contentEnd, existingWrapper!.content);
            } else if (existingWrapper) {
              const wrapped = nodeType.create(attrs, existingWrapper.content);
              tr.replaceWith(contentStart, contentEnd, wrapped);
            } else {
              const wrapped = nodeType.create(attrs, itemNode.content);
              tr.replaceWith(contentStart, contentEnd, wrapped);
            }
          }

          dispatch(tr);
        }
        return true;
      }
    }

    return wrapIn(nodeType, attrs)(state, dispatch);
  };
}

/**
 * Lift content out of a specific node type (not just the nearest wrapper).
 * Standard `lift()` always removes the closest wrapping, which is wrong when
 * e.g. a notice contains a list — clicking the notice toggle would remove
 * the list first instead of the notice.
 */
export function liftFromNodeType(nodeType: any): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    // Find the wrapping node of the specified type using blockRange with predicate
    const range = $from.blockRange($to, node => node.type === nodeType);
    if (!range) return false;
    if (dispatch) {
      // Lift content one level up (out of the target wrapper)
      dispatch(state.tr.lift(range, range.depth - 1));
    }
    return true;
  };
}

// ─── Mark/Node Active Checks ─────────────────────────────────────────────────

export function isMarkActive(state: EditorState, markType: any): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) {
    return !!markType.isInSet(state.storedMarks || $from.marks());
  }
  return state.doc.rangeHasMark(from, to, markType);
}

export function isBlockActive(state: EditorState, nodeType: any, attrs?: Record<string, any>): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === nodeType) {
      if (!attrs) return true;
      return Object.keys(attrs).every((key) => node.attrs[key] === attrs[key]);
    }
  }
  return false;
}

export function isHtmlTagActive(state: EditorState, tag: string): boolean {
  const markType = schema.marks.html_tag;
  const { from, $from, to, empty } = state.selection;
  if (empty) {
    return (state.storedMarks || $from.marks()).some(
      (m) => m.type === markType && m.attrs.tag === tag
    );
  }
  let found = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (found) return false;
    if (node.marks.some((m) => m.type === markType && m.attrs.tag === tag)) {
      found = true;
    }
  });
  return found;
}

export function toggleHtmlTag(tag: string): Command {
  return (state, dispatch) => {
    const markType = schema.marks.html_tag;
    const attrs = { tag };
    const sel = state.selection;
    const { empty } = sel;
    const $cursor = sel instanceof TextSelection ? sel.$cursor : null;

    if (empty && !$cursor) return false;
    if (!dispatch) return true;

    if ($cursor) {
      const marks = state.storedMarks || $cursor.marks();
      const existing = marks.find((m) => m.type === markType && m.attrs.tag === tag);
      if (existing) {
        dispatch(state.tr.removeStoredMark(existing));
      } else {
        dispatch(state.tr.addStoredMark(markType.create(attrs)));
      }
    } else {
      let has = false;
      const { from, to } = sel;
      state.doc.nodesBetween(from, to, (node) => {
        if (has) return false;
        if (node.marks.some((m) => m.type === markType && m.attrs.tag === tag)) {
          has = true;
        }
      });

      const tr = state.tr;
      const mark = markType.create(attrs);
      if (has) {
        tr.removeMark(from, to, mark);
      } else {
        tr.addMark(from, to, mark);
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/**
 * Get the closest list to the cursor (for nested lists)
 */
export function getClosestListType(state: EditorState): any {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    if (node.type === schema.nodes.bullet_list ||
        node.type === schema.nodes.ordered_list ||
        node.type === schema.nodes.checkbox_list) {
      return node.type;
    }
  }
  return null;
}

/**
 * Convert between list types - only selected items
 */
export function convertListType(fromItemType: any, toListType: any) {
  return (state: EditorState, dispatch?: any, view?: any) => {
    const { $from, $to } = state.selection;

    if (!dispatch) {
      return liftListItem(fromItemType)(state);
    }

    const range = $from.blockRange($to);
    if (!range) {
      return false;
    }

    // Find closest list and check if there's a parent list
    let closestListDepth = -1;
    let hasParentList = false;

    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d);
      if (node.type === schema.nodes.bullet_list ||
          node.type === schema.nodes.ordered_list ||
          node.type === schema.nodes.checkbox_list) {
        if (closestListDepth === -1) {
          closestListDepth = d;
        } else {
          hasParentList = true;
          break;
        }
      }
    }

    if (closestListDepth === -1) {
      return false;
    }

    const closestList = $from.node(closestListDepth);

    // If already the right list type, just lift out
    if (closestList.type === toListType) {
      return liftListItem(fromItemType)(state, dispatch);
    }

    // If this is a nested list (has parent list), use direct replacement
    if (hasParentList) {
      const listPos = $from.before(closestListDepth);
      const tr = state.tr;

      // Save cursor position relative to list start
      const cursorOffset = $from.pos - listPos;

      // Determine target item type
      const toItemType = toListType === schema.nodes.checkbox_list
        ? schema.nodes.checkbox_item
        : schema.nodes.list_item;

      // Build new list with converted items
      const newItems: any[] = [];
      closestList.content.forEach((item) => {
        if (item.type !== toItemType) {
          const newAttrs = toItemType === schema.nodes.checkbox_item
            ? { checked: false }
            : {};
          newItems.push(toItemType.create(newAttrs, item.content, item.marks));
        } else {
          newItems.push(item);
        }
      });

      // Create new list node
      const listAttrs = toListType === schema.nodes.ordered_list ? { order: 1 } : undefined;
      const newList = toListType.create(listAttrs, newItems);

      // Replace the list node
      tr.replaceRangeWith(listPos, listPos + closestList.nodeSize, newList);

      // Restore cursor position
      const newPos = listPos + cursorOffset;
      if (newPos >= 0 && newPos <= tr.doc.content.size) {
        tr.setSelection(state.selection.constructor.near(tr.doc.resolve(newPos)) as any);
      }

      dispatch(tr);
      return true;
    }

    // For top-level lists, use lift+wrap approach
    const combinedTr = state.tr;
    let currentState = state;

    // Step 1: Lift items out of current list
    const liftSuccess = liftListItem(fromItemType)(currentState, (liftTr) => {
      liftTr.steps.forEach(step => combinedTr.step(step));
      currentState = currentState.apply(liftTr);
    });

    if (!liftSuccess) {
      return false;
    }

    // Step 2: Wrap in new list type
    const listAttrs = toListType === schema.nodes.ordered_list ? { order: 1 } : undefined;
    const wrapSuccess = wrapInList(toListType, listAttrs)(currentState, (wrapTr) => {
      wrapTr.steps.forEach(step => combinedTr.step(step));
    });

    if (!wrapSuccess) {
      return false;
    }

    dispatch(combinedTr);
    return true;
  };
}
