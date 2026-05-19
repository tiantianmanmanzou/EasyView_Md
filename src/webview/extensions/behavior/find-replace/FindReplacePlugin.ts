/**
 * Find & Replace Extension
 *
 * Inspired by Outline's implementation with:
 * - Diacritic-insensitive search using lodash.deburr
 * - Multi-node text merging for cross-boundary matches
 * - Regex support
 * - Case sensitive toggle
 * - Replace current and replace all
 * - Auto-scroll to current match
 */

import { Plugin, PluginKey, EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import type { Node as ProsemirrorNode } from 'prosemirror-model';
import deburr from 'lodash/deburr';
import escapeRegExp from 'lodash/escapeRegExp';
import scrollIntoView from 'scroll-into-view-if-needed';

export const findAndReplaceKey = new PluginKey('findAndReplace');

export interface FindAndReplaceState {
  searchTerm: string;
  results: Array<{ from: number; to: number }>;
  currentIndex: number;
  caseSensitive: boolean;
  regexEnabled: boolean;
  isOpen: boolean;
}

interface MergedNode {
  text: string;
  pos: number;
}

/**
 * Find & Replace Plugin
 */
export function findAndReplacePlugin() {
  let editorView: EditorView | null = null;

  return new Plugin<FindAndReplaceState>({
    key: findAndReplaceKey,

    state: {
      init(): FindAndReplaceState {
        return {
          searchTerm: '',
          results: [],
          currentIndex: 0,
          caseSensitive: false,
          regexEnabled: false,
          isOpen: false,
        };
      },

      apply(tr, value, oldState, newState): FindAndReplaceState {
        const meta = tr.getMeta(findAndReplaceKey);

        if (meta) {
          const newValue = { ...value, ...meta };

          // If search term or options changed, re-search
          if (meta.searchTerm !== undefined ||
              meta.caseSensitive !== undefined ||
              meta.regexEnabled !== undefined) {
            const results = searchInDocument(
              newState.doc,
              newValue.searchTerm,
              newValue.caseSensitive,
              newValue.regexEnabled
            );

            return {
              ...newValue,
              results,
              currentIndex: results.length > 0 ? 0 : -1,
            };
          }

          return newValue;
        }

        // If document changed, remap results
        if (tr.docChanged) {
          const results = value.results.map(result => {
            const from = tr.mapping.map(result.from);
            const to = tr.mapping.map(result.to);
            return { from, to };
          }).filter(result => result.from < result.to);

          return {
            ...value,
            results,
            currentIndex: results.length > 0 ? Math.min(value.currentIndex, results.length - 1) : -1,
          };
        }

        return value;
      },
    },

    props: {
      decorations(state: EditorState): DecorationSet {
        const pluginState = findAndReplaceKey.getState(state);

        if (!pluginState || pluginState.results.length === 0) {
          return DecorationSet.empty;
        }

        const decorations = pluginState.results.map((result, index) => {
          const isCurrentResult = index === pluginState.currentIndex;
          const className = isCurrentResult
            ? 'find-result current-result'
            : 'find-result';

          return Decoration.inline(result.from, result.to, { class: className });
        });

        return DecorationSet.create(state.doc, decorations);
      },
    },

    view(view: EditorView) {
      editorView = view;

      return {
        update(view: EditorView, prevState: EditorState) {
          const prevPluginState = findAndReplaceKey.getState(prevState);
          const currentPluginState = findAndReplaceKey.getState(view.state);

          // Auto-scroll when current index changes
          if (currentPluginState && prevPluginState &&
              currentPluginState.currentIndex !== prevPluginState.currentIndex &&
              currentPluginState.currentIndex >= 0) {
            scrollToCurrentMatch();
          }
        },

        destroy() {
          editorView = null;
        },
      };
    },
  });
}

/**
 * Search in document with diacritic-insensitive matching
 */
function searchInDocument(
  doc: ProsemirrorNode,
  searchTerm: string,
  caseSensitive: boolean,
  regexEnabled: boolean
): Array<{ from: number; to: number }> {
  if (!searchTerm) {
    return [];
  }

  const results: Array<{ from: number; to: number }> = [];

  // Create regex
  let pattern: string;
  try {
    pattern = regexEnabled ? searchTerm : escapeRegExp(searchTerm);
  } catch (e) {
    return [];
  }

  const flags = caseSensitive ? 'gu' : 'gui';
  let regex: RegExp;

  try {
    regex = new RegExp(pattern, flags);
  } catch (e) {
    return [];
  }

  // Merge adjacent text nodes
  const mergedNodes: MergedNode[] = [];
  let currentText = '';
  let currentPos = 0;
  let hasText = false;

  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      if (!hasText) {
        currentPos = pos;
        hasText = true;
      }
      currentText += node.text;
    } else {
      if (hasText) {
        mergedNodes.push({ text: currentText, pos: currentPos });
        currentText = '';
        hasText = false;
      }
    }
  });

  // Don't forget the last node
  if (hasText) {
    mergedNodes.push({ text: currentText, pos: currentPos });
  }

  // Search in merged nodes with diacritic-insensitive matching
  mergedNodes.forEach(({ text, pos }) => {
    // Diacritic-insensitive: search in deburr(text) + text
    // This allows finding "cafe" in "café" while preserving correct positions
    const searchText = deburr(text) + text;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(searchText)) !== null) {
      if (match[0] === '') break; // Prevent infinite loop

      // Calculate actual position
      // If match.index >= text.length, it's in the second half (deburr part)
      const index = match.index >= text.length ? match.index - text.length : match.index;

      // Prevent wrap-around matches
      if (index + match[0].length > text.length) {
        continue;
      }

      const from = pos + index;
      const to = from + match[0].length;

      // Deduplicate
      if (!results.some(r => r.from === from && r.to === to)) {
        results.push({ from, to });
      }
    }
  });

  return results;
}

/**
 * Scroll to current match
 */
function scrollToCurrentMatch() {
  // Use setTimeout to ensure DOM is updated
  setTimeout(() => {
    const element = document.querySelector('.current-result');
    if (element) {
      scrollIntoView(element, {
        scrollMode: 'if-needed',
        block: 'center',
        behavior: 'smooth',
      });
    }
  }, 0);
}

/**
 * Commands
 */

export function find(searchTerm: string, caseSensitive = false, regexEnabled = false) {
  return (state: EditorState, dispatch?: (tr: any) => void): boolean => {
    if (dispatch) {
      const tr = state.tr.setMeta(findAndReplaceKey, {
        searchTerm,
        caseSensitive,
        regexEnabled,
        isOpen: true,
      });
      dispatch(tr);
    }
    return true;
  };
}

export function nextMatch() {
  return (state: EditorState, dispatch?: (tr: any) => void): boolean => {
    const pluginState = findAndReplaceKey.getState(state);

    if (!pluginState || pluginState.results.length === 0) {
      return false;
    }

    if (dispatch) {
      const nextIndex = (pluginState.currentIndex + 1) % pluginState.results.length;
      const tr = state.tr.setMeta(findAndReplaceKey, {
        currentIndex: nextIndex,
      });
      dispatch(tr);
    }
    return true;
  };
}

export function prevMatch() {
  return (state: EditorState, dispatch?: (tr: any) => void): boolean => {
    const pluginState = findAndReplaceKey.getState(state);

    if (!pluginState || pluginState.results.length === 0) {
      return false;
    }

    if (dispatch) {
      const prevIndex = pluginState.currentIndex - 1 < 0
        ? pluginState.results.length - 1
        : pluginState.currentIndex - 1;
      const tr = state.tr.setMeta(findAndReplaceKey, {
        currentIndex: prevIndex,
      });
      dispatch(tr);
    }
    return true;
  };
}

export function replaceCurrent(replaceText: string) {
  return (state: EditorState, dispatch?: (tr: any) => void): boolean => {
    const pluginState = findAndReplaceKey.getState(state);

    if (!pluginState || pluginState.results.length === 0 || pluginState.currentIndex < 0) {
      return false;
    }

    if (dispatch) {
      const result = pluginState.results[pluginState.currentIndex];
      const tr = state.tr.insertText(replaceText, result.from, result.to);
      dispatch(tr);

      // Re-search after replace
      const newState = state.apply(tr);
      const searchTr = newState.tr.setMeta(findAndReplaceKey, {
        searchTerm: pluginState.searchTerm,
        caseSensitive: pluginState.caseSensitive,
        regexEnabled: pluginState.regexEnabled,
      });
      dispatch(searchTr);
    }
    return true;
  };
}

export function replaceAll(replaceText: string) {
  return (state: EditorState, dispatch?: (tr: any) => void): boolean => {
    const pluginState = findAndReplaceKey.getState(state);

    if (!pluginState || pluginState.results.length === 0) {
      return false;
    }

    if (dispatch) {
      let tr = state.tr;
      let offset = 0;

      // Replace all results from last to first to avoid position shifts
      const sortedResults = [...pluginState.results].sort((a, b) => b.from - a.from);

      sortedResults.forEach(result => {
        tr = tr.insertText(replaceText, result.from, result.to);
      });

      dispatch(tr);

      // Re-search after replace all
      const newState = state.apply(tr);
      const searchTr = newState.tr.setMeta(findAndReplaceKey, {
        searchTerm: pluginState.searchTerm,
        caseSensitive: pluginState.caseSensitive,
        regexEnabled: pluginState.regexEnabled,
      });
      dispatch(searchTr);
    }
    return true;
  };
}

export function clearSearch() {
  return (state: EditorState, dispatch?: (tr: any) => void): boolean => {
    if (dispatch) {
      const tr = state.tr.setMeta(findAndReplaceKey, {
        searchTerm: '',
        results: [],
        currentIndex: -1,
        isOpen: false,
      });
      dispatch(tr);
    }
    return true;
  };
}

export function openFindAndReplace() {
  return (state: EditorState, dispatch?: (tr: any) => void): boolean => {
    if (dispatch) {
      const tr = state.tr.setMeta(findAndReplaceKey, {
        isOpen: true,
      });
      dispatch(tr);
    }
    return true;
  };
}

export function closeFindAndReplace() {
  return (state: EditorState, dispatch?: (tr: any) => void): boolean => {
    if (dispatch) {
      const tr = state.tr.setMeta(findAndReplaceKey, {
        isOpen: false,
      });
      dispatch(tr);
    }
    return true;
  };
}
