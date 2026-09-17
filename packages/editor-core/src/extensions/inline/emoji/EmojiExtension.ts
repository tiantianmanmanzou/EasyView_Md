/**
 * EmojiExtension
 *
 * Visual rendering of :emoji_shortcode: patterns + autocomplete popup.
 * Markdown is preserved as-is (`:heart:` stays `:heart:` in the file).
 * The editor shows the emoji character visually via inline decorations.
 */

import type { Schema } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';
import { Extension } from '../../../editor/EditorExtension';
import { _isMouseDragging } from '../../../editor/EditorCore';
import { nameToEmoji } from 'gemoji';

// ─── Regex for emoji shortcodes ──────────────────────────────────────────────

/** Matches :shortcode: patterns — alphanumeric, underscore, plus, minus */
const EMOJI_RE = /:([a-z0-9_+-]+):/g;

// ─── Decoration Plugin ───────────────────────────────────────────────────────

const emojiDecoKey = new PluginKey<DecorationSet>('emojiDecorations');

/**
 * Scan the document for :emoji: shortcodes and create inline decorations
 * that visually display the emoji character. Skips ranges where the cursor
 * is positioned so the user can edit the shortcode text.
 */
function buildEmojiDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [];
  const { from: selFrom, to: selTo } = state.selection;

  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;

    EMOJI_RE.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = EMOJI_RE.exec(node.text)) !== null) {
      const shortcode = match[1];
      const emoji = nameToEmoji[shortcode];
      if (!emoji) continue;

      const from = pos + match.index;
      const to = from + match[0].length;

      // Don't decorate if cursor is inside or adjacent to this shortcode
      if (selFrom <= to && selTo >= from) continue;

      decorations.push(
        Decoration.inline(from, to, {
          class: 'emoji-shortcode',
          'data-emoji': emoji,
          title: `:${shortcode}:`,
        }),
      );
    }
  });

  return DecorationSet.create(state.doc, decorations);
}

function emojiDecorationPlugin(): Plugin {
  // Track which emoji positions are near cursor to avoid unnecessary rebuilds.
  // Only rebuild decorations when cursor actually moves into/out of an emoji range.
  let lastNearCursorKey = '';

  return new Plugin({
    key: emojiDecoKey,
    state: {
      init(_, state) {
        lastNearCursorKey = '';
        return buildEmojiDecorations(state);
      },
      apply(tr, decorationSet, _oldState, newState) {
        // Freeze during mouse drag to prevent DOM mutations
        if (_isMouseDragging) return decorationSet;
        if (tr.docChanged) {
          lastNearCursorKey = '';
          return buildEmojiDecorations(newState);
        }
        if (tr.selectionSet) {
          // Only rebuild if cursor moved into/out of an emoji range
          const { from: selFrom, to: selTo } = newState.selection;
          const nearPositions: number[] = [];
          newState.doc.descendants((node, pos) => {
            if (!node.isText || !node.text) return;
            EMOJI_RE.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = EMOJI_RE.exec(node.text)) !== null) {
              const from = pos + match.index;
              const to = from + match[0].length;
              if (selFrom <= to && selTo >= from) nearPositions.push(from);
            }
          });
          const key = nearPositions.join(',');
          if (key !== lastNearCursorKey) {
            lastNearCursorKey = key;
            return buildEmojiDecorations(newState);
          }
        }
        return decorationSet;
      },
    },
    props: {
      decorations(state) {
        return emojiDecoKey.getState(state) ?? DecorationSet.empty;
      },
    },
  });
}

// ─── Autocomplete Plugin ─────────────────────────────────────────────────────

/** Minimum chars after `:` before showing autocomplete */
const MIN_QUERY_LENGTH = 2;
/** Maximum items in the autocomplete dropdown */
const MAX_RESULTS = 8;

/** Pre-built array of all shortcode entries for fast lookup */
const allShortcodes: Array<{ name: string; emoji: string }> = [];
for (const name of Object.keys(nameToEmoji)) {
  allShortcodes.push({ name, emoji: nameToEmoji[name] });
}

interface EmojiAutocompleteState {
  active: boolean;
  query: string;
  from: number; // position of the `:` char
  to: number; // position after the query (before closing `:`)
  selectedIndex: number;
}

const emojiAutocompleteKey = new PluginKey<EmojiAutocompleteState>('emojiAutocomplete');

/**
 * Detect if the cursor is in a `:query` context (typing an emoji shortcode).
 * Returns null if not in autocomplete context.
 */
function detectEmojiQuery(state: EditorState): { from: number; to: number; query: string } | null {
  const { $from, empty } = state.selection;
  if (!empty) return null;

  // Must be in a textblock
  if (!$from.parent.isTextblock) return null;

  // Get text before cursor in this textblock
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');

  // Find the last unmatched `:` — there should be no space before cursor
  // and no completed `:shortcode:` between the `:` and cursor
  const colonIdx = textBefore.lastIndexOf(':');
  if (colonIdx === -1) return null;

  const query = textBefore.slice(colonIdx + 1);

  // Query must be alphanumeric/underscore/plus/minus only, no spaces
  if (!/^[a-z0-9_+-]*$/i.test(query)) return null;
  if (query.length < MIN_QUERY_LENGTH) return null;

  // Make sure there's no other `:` in the query (would mean a completed shortcode)
  if (query.includes(':')) return null;

  // Check if this colon is preceded by a text character (not whitespace or start of node)
  // If preceded by a letter/digit, it's probably a URL or code, not an emoji trigger
  if (colonIdx > 0) {
    const charBefore = textBefore[colonIdx - 1];
    if (/[a-zA-Z0-9/]/.test(charBefore)) return null;
  }

  const blockStart = $from.start();
  return {
    from: blockStart + colonIdx,
    to: blockStart + colonIdx + 1 + query.length,
    query: query.toLowerCase(),
  };
}

/** Filter and rank emoji entries by query */
function filterEmoji(query: string): Array<{ name: string; emoji: string }> {
  const results: Array<{ name: string; emoji: string; score: number }> = [];

  for (const entry of allShortcodes) {
    // Exact prefix match gets highest score
    if (entry.name.startsWith(query)) {
      results.push({ ...entry, score: 0 });
    } else if (entry.name.includes(query)) {
      results.push({ ...entry, score: 1 });
    }

    if (results.length >= MAX_RESULTS * 3) break; // early exit for perf
  }

  results.sort((a, b) => a.score - b.score || a.name.length - b.name.length);
  return results.slice(0, MAX_RESULTS);
}

/** The autocomplete popup DOM element */
let popupEl: HTMLElement | null = null;
let currentView: EditorView | null = null;

function createPopup(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'emoji-autocomplete';
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

function hidePopup() {
  if (popupEl) popupEl.style.display = 'none';
}

function showPopup(
  view: EditorView,
  acState: EmojiAutocompleteState,
) {
  if (!popupEl) popupEl = createPopup();
  currentView = view;

  const results = filterEmoji(acState.query);
  if (results.length === 0) {
    hidePopup();
    return;
  }

  popupEl.innerHTML = '';

  results.forEach((entry, i) => {
    const item = document.createElement('div');
    item.className = `emoji-autocomplete-item${i === acState.selectedIndex ? ' selected' : ''}`;
    item.innerHTML = `<span class="emoji-autocomplete-char">${entry.emoji}</span><span class="emoji-autocomplete-name">:${entry.name}:</span>`;

    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      insertEmoji(view, acState.from, acState.to, entry.name);
    });
    item.addEventListener('mouseenter', () => {
      // Update selected index visually
      popupEl?.querySelectorAll('.emoji-autocomplete-item').forEach((el, j) => {
        el.classList.toggle('selected', j === i);
      });
    });

    popupEl!.appendChild(item);
  });

  // Position popup near cursor
  const coords = view.coordsAtPos(acState.from);
  const editorRect = view.dom.closest('.ProseMirror')?.getBoundingClientRect() ??
    view.dom.getBoundingClientRect();

  popupEl.style.display = 'block';

  // Position below the text
  const popupRect = popupEl.getBoundingClientRect();
  let left = coords.left;
  let top = coords.bottom + 4;

  // Keep within viewport
  if (left + popupRect.width > window.innerWidth - 8) {
    left = window.innerWidth - popupRect.width - 8;
  }
  if (top + popupRect.height > window.innerHeight - 8) {
    top = coords.top - popupRect.height - 4;
  }

  popupEl.style.left = `${left}px`;
  popupEl.style.top = `${top}px`;
}

function insertEmoji(view: EditorView, from: number, to: number, name: string) {
  const text = `:${name}: `;
  const tr = view.state.tr.replaceWith(from, to, view.state.schema.text(text));
  // Dismiss autocomplete
  tr.setMeta(emojiAutocompleteKey, { dismiss: true });
  view.dispatch(tr);
  view.focus();
}

function emojiAutocompletePlugin(): Plugin {
  return new Plugin<EmojiAutocompleteState>({
    key: emojiAutocompleteKey,
    state: {
      init() {
        return { active: false, query: '', from: 0, to: 0, selectedIndex: 0 };
      },
      apply(tr, prev, _oldState, newState) {
        // Check for explicit dismiss
        const meta = tr.getMeta(emojiAutocompleteKey);
        if (meta?.dismiss) {
          return { active: false, query: '', from: 0, to: 0, selectedIndex: 0 };
        }

        const detected = detectEmojiQuery(newState);
        if (!detected) {
          return { active: false, query: '', from: 0, to: 0, selectedIndex: 0 };
        }

        // Keep selected index if query changed but preserve within bounds
        const results = filterEmoji(detected.query);
        let selectedIndex = prev.active ? prev.selectedIndex : 0;
        if (selectedIndex >= results.length) selectedIndex = 0;

        return {
          active: true,
          query: detected.query,
          from: detected.from,
          to: detected.to,
          selectedIndex,
        };
      },
    },
    view() {
      return {
        update(view) {
          if (_isMouseDragging) return;
          const acState = emojiAutocompleteKey.getState(view.state);
          if (acState?.active) {
            showPopup(view, acState);
          } else {
            hidePopup();
          }
        },
        destroy() {
          if (popupEl) {
            popupEl.remove();
            popupEl = null;
          }
        },
      };
    },
    props: {
      handleKeyDown(view, event) {
        const acState = emojiAutocompleteKey.getState(view.state);
        if (!acState?.active) return false;

        const results = filterEmoji(acState.query);
        if (results.length === 0) return false;

        switch (event.key) {
          case 'ArrowDown': {
            event.preventDefault();
            const next = (acState.selectedIndex + 1) % results.length;
            // Update plugin state
            const tr = view.state.tr.setMeta(emojiAutocompleteKey, { setIndex: next });
            // We need to update the state directly since setMeta alone won't trigger apply properly
            // Instead, manually update popup
            acState.selectedIndex = next;
            showPopup(view, acState);
            return true;
          }
          case 'ArrowUp': {
            event.preventDefault();
            const prev = (acState.selectedIndex - 1 + results.length) % results.length;
            acState.selectedIndex = prev;
            showPopup(view, acState);
            return true;
          }
          case 'Enter':
          case 'Tab': {
            event.preventDefault();
            const selected = results[acState.selectedIndex];
            if (selected) {
              insertEmoji(view, acState.from, acState.to, selected.name);
            }
            return true;
          }
          case 'Escape': {
            event.preventDefault();
            hidePopup();
            // Dismiss by moving cursor or just hide visually
            const tr = view.state.tr.setMeta(emojiAutocompleteKey, { dismiss: true });
            view.dispatch(tr);
            return true;
          }
        }

        return false;
      },
    },
  });
}

// ─── Extension ───────────────────────────────────────────────────────────────

export class EmojiExtension extends Extension {
  get name() {
    return 'emoji';
  }

  plugins(_schema: Schema): Plugin[] {
    return [emojiDecorationPlugin(), emojiAutocompletePlugin()];
  }
}
