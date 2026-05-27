/**
 * ListsExtension
 *
 * Handles all list types: bullet, ordered, checkbox.
 * Schema nodes, input rules, keymaps, plugins, and serializer.
 * Includes cross-type list lifting (liftFromSublistCrossType) for
 * handling Enter/Backspace in nested lists of different types.
 */

import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
import { wrappingInputRule, type InputRule } from 'prosemirror-inputrules';
import type { NodeSpec, Schema, Node as ProsemirrorNode } from 'prosemirror-model';
import type { Command } from 'prosemirror-commands';
import { chainCommands } from 'prosemirror-commands';
import type { EditorView } from 'prosemirror-view';
import { wrapInList, splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { keymap } from 'prosemirror-keymap';
import {
  Extension,
  type SerializerNodeHandler,
} from '../../../editor/EditorExtension';

// ─── Lists Extension ─────────────────────────────────────────────────────────

export class ListsExtension extends Extension {
  get name() {
    return 'lists';
  }

  get nodes(): Record<string, NodeSpec> {
    return {
      bullet_list: {
        content: 'list_item+',
        group: 'block list',
        parseDOM: [{ tag: 'ul' }],
        toDOM() {
          return ['ul', 0];
        },
      },
      ordered_list: {
        attrs: {
          order: { default: 1, validate: 'number' },
        },
        content: 'list_item+',
        group: 'block list',
        parseDOM: [
          {
            tag: 'ol',
            getAttrs(dom: HTMLOListElement) {
              return {
                order: dom.hasAttribute('start')
                  ? +dom.getAttribute('start')!
                  : 1,
              };
            },
          },
        ],
        toDOM(node) {
          return node.attrs.order === 1
            ? ['ol', 0]
            : ['ol', { start: node.attrs.order }, 0];
        },
      },
      list_item: {
        attrs: {},
        content: 'block+',
        defining: true,
        parseDOM: [{ tag: 'li:not([data-type])' }],
        toDOM() {
          return ['li', ['div', { class: 'list-item-content' }, 0]];
        },
      },
      checkbox_list: {
        content: 'checkbox_item+',
        group: 'block list',
        parseDOM: [
          { tag: 'ul.checkbox-list' },
          // Standard HTML: <ul> containing <li> with <input type="checkbox">
          {
            tag: 'ul',
            priority: 60,
            getAttrs(dom: HTMLUListElement) {
              const items = dom.querySelectorAll(':scope > li');
              for (const li of items) {
                if (li.querySelector(':scope > input[type="checkbox"]')) return {};
              }
              return false;
            },
          },
        ],
        toDOM() {
          return ['ul', { class: 'checkbox-list' }, 0];
        },
      },
      checkbox_item: {
        attrs: {
          checked: { default: false }, // false | true | 'inapplicable'
        },
        content: 'block+',
        defining: true,
        parseDOM: [
          {
            tag: 'li[data-type="checkbox_item"]',
            getAttrs(dom: HTMLLIElement) {
              const val = dom.dataset.checked;
              if (val === 'inapplicable') return { checked: 'inapplicable' };
              return { checked: val === 'true' };
            },
          },
          // Standard HTML: <li> with <input type="checkbox">
          {
            tag: 'li',
            priority: 60,
            getAttrs(dom: HTMLLIElement) {
              const checkbox = dom.querySelector(':scope > input[type="checkbox"]');
              if (!checkbox) return false;
              return { checked: (checkbox as HTMLInputElement).checked || checkbox.hasAttribute('checked') };
            },
          },
        ],
        toDOM(node) {
          const checked = node.attrs.checked;
          const cls = checked === 'inapplicable' ? 'inapplicable' : checked ? 'checked' : '';
          return [
            'li',
            {
              'data-type': 'checkbox_item',
              'data-checked': String(checked),
              class: cls,
            },
            ['span', { class: 'checkbox', contenteditable: 'false' }],
            ['div', { class: 'checkbox-content' }, 0],
          ];
        },
      },
    };
  }

  inputRules(schema: Schema): InputRule[] {
    return [
      // `- ` → bullet_list
      wrappingInputRule(/^\s*[-+*]\s$/, schema.nodes.bullet_list),
      // `1. ` (or any number) → ordered_list with order attr
      wrappingInputRule(
        /^(\d+)\.\s$/,
        schema.nodes.ordered_list,
        (match) => ({ order: +match[1] }),
        (match, node) => node.childCount + node.attrs.order === +match[1]
      ),
      // `[ ] ` → checkbox_list (unchecked)
      wrappingInputRule(
        /^\s*\[\s\]\s$/,
        schema.nodes.checkbox_list,
        undefined,
        undefined
      ),
      // `[x] ` → checkbox_list (checked)
      wrappingInputRule(
        /^\s*\[x\]\s$/i,
        schema.nodes.checkbox_list,
        undefined,
        undefined
      ),
    ];
  }

  keymaps(schema: Schema): Record<string, Command> {
    return {
      'Shift-Ctrl-7': wrapInList(schema.nodes.checkbox_list),
      'Shift-Ctrl-8': wrapInList(schema.nodes.bullet_list),
      'Shift-Ctrl-9': wrapInList(schema.nodes.ordered_list),
      'Mod-[': (state, dispatch) => {
        return chainCommands(
          liftListItem(schema.nodes.list_item),
          liftListItem(schema.nodes.checkbox_item)
        )(state, dispatch);
      },
      'Mod-]': (state, dispatch) => {
        return chainCommands(
          sinkListItem(schema.nodes.list_item),
          sinkListItem(schema.nodes.checkbox_item)
        )(state, dispatch);
      },
      'Tab': (state, dispatch, view) => {
        const canExecute = chainCommands(
          sinkListItem(schema.nodes.list_item),
          sinkListItem(schema.nodes.checkbox_item)
        )(state);

        if (!canExecute || !dispatch) {
          return canExecute;
        }

        const result = chainCommands(
          sinkListItem(schema.nodes.list_item),
          sinkListItem(schema.nodes.checkbox_item)
        )(state, dispatch);

        // Immediately restore focus
        if (result && view) {
          view.focus();
        }

        return result;
      },
      'Shift-Tab': (state, dispatch) => {
        return chainCommands(
          liftListItem(schema.nodes.list_item),
          liftListItem(schema.nodes.checkbox_item)
        )(state, dispatch);
      },
    };
  }

  plugins(schema: Schema): Plugin[] {
    return [
      this.buildListItemKeymap(schema),
      this.buildCheckboxKeymap(schema),
    ];
  }

  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {
      bullet_list(state, node) {
        state.renderList(node, '  ', () => '- ');
      },
      ordered_list(state, node) {
        const start = node.attrs.order || 1;
        state.renderList(node, '   ', (i: number) => `${start + i}. `);
      },
      list_item(state, node) {
        state.renderContent(node);
      },
      checkbox_list(state, node) {
        state.renderList(node, '  ', () => '- ');
      },
      checkbox_item(state, node) {
        const checked = node.attrs.checked;
        const prefix = checked === 'inapplicable' ? '[~] ' : checked ? '[x] ' : '[ ] ';
        state.write(prefix);
        state.renderContent(node);
      },
    };
  }

  // ── Private: Cross-type list lifting ──

  /**
   * Handle Enter/Backspace on empty item in a cross-type nested list.
   * E.g., empty list_item in a bullet_list inside a checkbox_item.
   * Standard liftListItem would create a bare paragraph (liftOutOfList path);
   * we also split the parent item so it becomes a proper new parent-type item.
   *
   * @param requireFirstItem - if true, only trigger when the item is the
   *   first (or only) child of its list (used for Backspace, so items with
   *   a previous sibling are handled by standard joinBackward instead).
   */
  private liftFromSublistCrossType(
    schema: Schema,
    itemType: any,
    parentItemType: any,
    parentAttrs: Record<string, any>,
    requireFirstItem = false
  ) {
    return (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
      const { $from, empty } = state.selection;
      if (!empty) return false;
      if ($from.parent.content.size !== 0 || $from.parentOffset !== 0) return false;

      // Find the nearest item of our type
      let itemDepth = -1;
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type === itemType) {
          itemDepth = d;
          break;
        }
      }
      if (itemDepth < 2) return false;

      // For Backspace: only handle when the item is the first in its list AND
      // the item is completely empty (single empty paragraph). Otherwise let
      // standard joinBackward handle it (e.g. delete extra empty paragraphs).
      if (requireFirstItem) {
        const itemIndex = $from.index(itemDepth - 1);
        if (itemIndex > 0) return false; // has previous sibling -> joinBackward
        const item = $from.node(itemDepth);
        if (item.childCount > 1) return false; // item has other content -> joinBackward
      }

      // The node containing the list -- must be the other item type
      const parentItemDepth = itemDepth - 2;
      if (parentItemDepth < 1) return false;
      const parentItem = $from.node(parentItemDepth);
      if (parentItem.type !== parentItemType) return false;

      if (!dispatch) return true;

      // Step 1: Lift from sublist (creates bare paragraph in parent item)
      let liftTr: Transaction | null = null;
      liftListItem(itemType)(state, (tr) => { liftTr = tr; });
      if (!liftTr) return false;

      // Step 2: Split parent item at the lifted position
      const intermediateState = state.apply(liftTr);
      let splitTr: Transaction | null = null;
      splitListItem(parentItemType, parentAttrs)(intermediateState, (tr) => { splitTr = tr; });

      // splitListItem may refuse (empty block at end of non-nested item).
      // Fall back to manual tr.split().
      if (!splitTr) {
        const $pos = intermediateState.selection.$from;
        if ($pos.parent.content.size === 0) {
          for (let dd = $pos.depth - 1; dd > 0; dd--) {
            if ($pos.node(dd).type === parentItemType) {
              const splitDepth = $pos.depth - dd;
              splitTr = intermediateState.tr.split(
                $pos.before($pos.depth), splitDepth,
                [{ type: parentItemType, attrs: parentAttrs }]
              );
              break;
            }
          }
        }
      }

      if (splitTr) {
        // Combine steps from both transactions into one
        const combined = state.tr;
        for (const step of (liftTr as Transaction).steps) {
          combined.step(step);
        }
        for (const step of (splitTr as Transaction).steps) {
          combined.step(step);
        }
        dispatch(combined.scrollIntoView());
      } else {
        // Both split methods failed -- just apply the lift
        dispatch((liftTr as Transaction).scrollIntoView());
      }

      return true;
    };
  }

  // ── Private: Same-type sublist lifting ──

  /**
   * Handle Enter on empty item in a same-type nested list.
   * E.g., empty list_item in a bullet_list inside another list_item in a parent bullet_list.
   * Standard liftListItem may fail in some nesting configurations;
   * this handler explicitly lifts the item to become a sibling of the parent item.
   */
  private liftFromSameTypeSublist(
    schema: Schema,
    itemType: any,
    listTypes: any[]
  ) {
    return (state: EditorState, dispatch?: (tr: Transaction) => void): boolean => {
      const { $from, empty } = state.selection;
      if (!empty) return false;
      if ($from.parent.content.size !== 0 || $from.parentOffset !== 0) return false;

      // Find the nearest item of our type
      let itemDepth = -1;
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type === itemType) {
          itemDepth = d;
          break;
        }
      }
      if (itemDepth < 2) return false;

      // The item must be single-child (just the empty paragraph)
      const item = $from.node(itemDepth);
      if (item.childCount > 1) return false;

      // Parent must be a same-type list
      const listNode = $from.node(itemDepth - 1);
      if (!listTypes.some(t => listNode.type === t)) return false;

      // Grandparent must be a same-type item (confirming we're nested)
      const parentItemDepth = itemDepth - 2;
      if (parentItemDepth < 1) return false;
      const parentItem = $from.node(parentItemDepth);
      if (parentItem.type !== itemType) return false;

      // We're in a same-type nested list — use liftListItem
      return liftListItem(itemType)(state, dispatch);
    };
  }

  // ── Private: List Item Keymap Plugin ──

  private buildListItemKeymap(schema: Schema): Plugin {
    // Same-type handler: list_item inside bullet_list/ordered_list inside list_item
    const liftListItemSameType = this.liftFromSameTypeSublist(
      schema, schema.nodes.list_item,
      [schema.nodes.bullet_list, schema.nodes.ordered_list]
    );
    // Cross-type handlers for Enter (any empty item)
    const liftListItemFromCheckbox = this.liftFromSublistCrossType(
      schema, schema.nodes.list_item, schema.nodes.checkbox_item, { checked: false }
    );
    // Cross-type handlers for Backspace (only first/only item in sublist)
    const bsLiftListItemFromCheckbox = this.liftFromSublistCrossType(
      schema, schema.nodes.list_item, schema.nodes.checkbox_item, { checked: false }, true
    );
    const structuredBackspace = (state: EditorState, dispatch?: (tr: Transaction) => void) => {
      const { $from, empty } = state.selection;
      if (!empty) return false;
      if ($from.parentOffset !== 0 || $from.parent.content.size === 0) return false;

      let closestListType: any = null;
      let inListItem = false;

      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type === schema.nodes.list_item) {
          inListItem = true;
        }
        if (
          node.type === schema.nodes.bullet_list ||
          node.type === schema.nodes.ordered_list ||
          node.type === schema.nodes.checkbox_list
        ) {
          if (!closestListType) {
            closestListType = node.type;
          }
        }
      }

      if (!inListItem || !closestListType) return false;

      return liftListItem(schema.nodes.list_item)(state, dispatch);
    };

    return keymap({
      Enter: chainCommands(
        // Same-type: empty list_item in nested bullet_list/ordered_list -> lift to parent list
        liftListItemSameType,
        // Cross-type: list_item inside checkbox_item -> lift + split into new checkbox_item
        liftListItemFromCheckbox,
        // Standard: exit on empty
        (state, dispatch) => {
          const { $from, empty } = state.selection;
          if (!empty) return false;

          // Check if in list_item (but NOT if a checkbox_item is between us and the list_item)
          for (let d = $from.depth; d > 0; d--) {
            const nodeType = $from.node(d).type;
            if (nodeType === schema.nodes.checkbox_item) break; // in a nested sub-list, not our job
            if (nodeType === schema.nodes.list_item) {
              // Check if empty paragraph
              if ($from.parent.content.size === 0 && $from.parentOffset === 0) {
                const listItem = $from.node(d);
                if (listItem.childCount > 1) {
                  // Item has other content (e.g. text + sublist + empty paragraph)
                  // Split the item to separate the empty paragraph into a new item
                  if (dispatch) {
                    dispatch(state.tr.split($from.before($from.depth), 1).scrollIntoView());
                  }
                  return true;
                }
                return liftListItem(schema.nodes.list_item)(state, dispatch);
              }
              break;
            }
          }
          return false;
        },
        // Then split - try with empty attrs like checkbox
        (state, dispatch) => splitListItem(schema.nodes.list_item, {})(state, dispatch)
      ),
      // Backspace: remove one list level at a time for non-empty items,
      // then fall back to existing cross-type empty-item handling.
      Backspace: chainCommands(
        structuredBackspace,
        bsLiftListItemFromCheckbox
      ),
    });
  }

  // ── Private: Checkbox Keymap Plugin ──

  private buildCheckboxKeymap(schema: Schema): Plugin {
    // Same-type handler: checkbox_item inside checkbox_list inside checkbox_item
    const liftCheckboxSameType = this.liftFromSameTypeSublist(
      schema, schema.nodes.checkbox_item,
      [schema.nodes.checkbox_list]
    );
    // Cross-type handlers for Enter (any empty item)
    const liftCheckboxFromListItem = this.liftFromSublistCrossType(
      schema, schema.nodes.checkbox_item, schema.nodes.list_item, {}
    );
    // Cross-type handlers for Backspace (only first/only item in sublist)
    const bsLiftCheckboxFromListItem = this.liftFromSublistCrossType(
      schema, schema.nodes.checkbox_item, schema.nodes.list_item, {}, true
    );
    const structuredBackspace = (state: EditorState, dispatch?: (tr: Transaction) => void) => {
      const { $from, empty } = state.selection;
      if (!empty) return false;
      if ($from.parentOffset !== 0 || $from.parent.content.size === 0) return false;

      let closestListType: any = null;
      let inCheckboxItem = false;

      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type === schema.nodes.checkbox_item) {
          inCheckboxItem = true;
        }
        if (
          node.type === schema.nodes.bullet_list ||
          node.type === schema.nodes.ordered_list ||
          node.type === schema.nodes.checkbox_list
        ) {
          if (!closestListType) {
            closestListType = node.type;
          }
        }
      }

      if (!inCheckboxItem || !closestListType) return false;

      return liftListItem(schema.nodes.checkbox_item)(state, dispatch);
    };

    return keymap({
      Enter: chainCommands(
        // Same-type: empty checkbox_item in nested checkbox_list -> lift to parent list
        liftCheckboxSameType,
        // Cross-type: checkbox_item inside list_item -> lift + split into new list_item
        liftCheckboxFromListItem,
        // Standard: exit on empty
        (state, dispatch) => {
          const { $from, empty } = state.selection;
          if (!empty) return false;

          // Check if in checkbox_item (but NOT if a list_item is between us and the checkbox_item)
          for (let d = $from.depth; d > 0; d--) {
            const nodeType = $from.node(d).type;
            if (nodeType === schema.nodes.list_item) break; // in a nested sub-list, not our job
            if (nodeType === schema.nodes.checkbox_item) {
              // Check if empty paragraph
              if ($from.parent.content.size === 0 && $from.parentOffset === 0) {
                const checkboxItem = $from.node(d);
                if (checkboxItem.childCount > 1) {
                  // Item has other content -- split instead of lift
                  if (dispatch) {
                    dispatch(state.tr.split($from.before($from.depth), 1).scrollIntoView());
                  }
                  return true;
                }
                return liftListItem(schema.nodes.checkbox_item)(state, dispatch);
              }
              break;
            }
          }
          return false;
        },
        // Then split
        splitListItem(schema.nodes.checkbox_item, { checked: false })
      ),
      // Backspace: remove one list level at a time for non-empty items,
      // then fall back to existing cross-type empty-item handling.
      Backspace: chainCommands(
        structuredBackspace,
        bsLiftCheckboxFromListItem
      ),
    });
  }
}
