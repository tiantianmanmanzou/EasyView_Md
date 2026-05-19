/**
 * EditorCore — creates and manages the ProseMirror EditorView.
 *
 * Responsible for:
 * - Building plugins/nodeViews from Extensions via ExtensionManager
 * - Creating and managing EditorState / EditorView
 * - Content management (markdown <-> ProseMirror)
 * - Image path resolution for webview URIs (delegated to EditorImageManager)
 * - Core plugins (history, dropCursor)
 * - Paste / click handlers (delegated to EditorEventHandlers)
 * - Lifecycle (init / destroy)
 *
 * UI concerns (toolbars, popups, panels, ToC, file header, source mode)
 * are handled by the caller through callbacks and direct view access.
 */

import {
  EditorState,
  TextSelection,
  NodeSelection,
  type Transaction,
} from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { history, undo, redo, undoDepth, isHistoryTransaction } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { dropCursor } from 'prosemirror-dropcursor';
import type { Node as ProsemirrorNode } from 'prosemirror-model';

import { ExtensionManager } from './EditorExtensionManager';
import type { Extension } from './EditorExtension';
import { schema } from './EditorSchema';
import { createParser, createPasteParser, parseMarkdown } from './lib/MarkdownParser';
import { serializer } from './lib/MarkdownSerializer';

import { EditorImageManager } from './EditorImageManager';
import {
  handleClickOn,
  handleClick,
  preserveImageSelection,
  handlePaste,
  handlePastePlainText,
} from './EditorEventHandlers';

// ─── Config ──────────────────────────────────────────────────────────────────

export interface EditorCoreConfig {
  /** Extension instances */
  extensions: Extension[];

  /** Additional keymaps injected by the host (e.g. Mod-k for link, Mod-s for save) */
  keymaps?: Record<string, (...args: any[]) => boolean>;

  /** Called after every transaction — use for toolbar / ToC / image toolbar updates */
  onDispatch?: (view: EditorView, tr: Transaction) => void;

  /** Called when document content changes — use for syncing back to VS Code */
  onContentChange?: (markdown: string) => void;

  /** Called when an image node is directly clicked */
  onImageClick?: (view: EditorView, pos: number, node: ProsemirrorNode, dom: HTMLElement) => void;

  /** Called on Ctrl+Click of a link (open externally) */
  onOpenLink?: (href: string) => void;

  /** Called on regular click of a link (show edit popup) */
  onLinkSelect?: (view: EditorView, href: string) => void;

  /** Called when native undo stack is exhausted — return true if cross-mode undo was handled */
  onUndoExhausted?: () => boolean;

  /** Called when native redo stack is exhausted — return true if cross-mode redo was handled */
  onRedoExhausted?: () => boolean;
}

// Module-level flag: true while processing a drag-selection transaction.
// Decoration plugins check this to freeze their output and avoid
// DOM mutations that break native drag-to-select.
export let _isMouseDragging = false;

// Track whether the mouse has actually moved since the last mousedown.
let _mouseHasMoved = false;

// ─── EditorCore ────────────────────────────────────────────────────────────

export class EditorCore {
  private manager: ExtensionManager;
  private _view: EditorView | null = null;
  private readonly parser;
  private readonly pasteParser;
  private config: EditorCoreConfig;
  private imageManager: EditorImageManager;

  // Content state
  private _isUpdatingFromExtension = false;
  private _currentContent = '';
  private _syncTimer: ReturnType<typeof setTimeout> | null = null;
  private _suppressHistory = false;

  constructor(config: EditorCoreConfig) {
    const t0 = performance.now();
    this.config = config;

    const t1 = performance.now();
    this.manager = new ExtensionManager(config.extensions);
    console.log(`[InLineMd perf]   ExtensionManager: ${(performance.now() - t1).toFixed(1)}ms`);

    const t2 = performance.now();
    this.parser = createParser();
    console.log(`[InLineMd perf]   createParser: ${(performance.now() - t2).toFixed(1)}ms`);

    const t3 = performance.now();
    this.pasteParser = createPasteParser();
    console.log(`[InLineMd perf]   createPasteParser: ${(performance.now() - t3).toFixed(1)}ms`);

    this.imageManager = new EditorImageManager();
    console.log(`[InLineMd perf]   EditorCore constructor TOTAL: ${(performance.now() - t0).toFixed(1)}ms`);
  }

  // ── Accessors ──

  get view(): EditorView | null {
    return this._view;
  }

  get currentContent(): string {
    return this._currentContent;
  }

  set currentContent(value: string) {
    this._currentContent = value;
  }

  get isUpdatingFromExtension(): boolean {
    return this._isUpdatingFromExtension;
  }

  set isUpdatingFromExtension(value: boolean) {
    this._isUpdatingFromExtension = value;
  }

  get extensionManager(): ExtensionManager {
    return this.manager;
  }

  // ── Lifecycle ──

  init(element: HTMLElement): void {
    const t0 = performance.now();
    const state = this.createState('');
    console.log(`[InLineMd perf]   createState(empty): ${(performance.now() - t0).toFixed(1)}ms`);

    const t1 = performance.now();
    const nodeViews = this.manager.buildNodeViews();
    console.log(`[InLineMd perf]   buildNodeViews: ${(performance.now() - t1).toFixed(1)}ms`);

    const t2 = performance.now();
    this._view = new EditorView(element, {
      state,
      nodeViews,
      dispatchTransaction: (tr) => this.dispatch(tr),
      handleClickOn: (view, pos, node, nodePos, event, direct) =>
        handleClickOn(view, pos, node, nodePos, event as MouseEvent, direct, this.config),
      createSelectionBetween: (view, $anchor, _$head) =>
        preserveImageSelection(view, $anchor),
      handleClick: (view, pos, event) =>
        handleClick(view, pos, event as MouseEvent, this.config),
      handlePaste: (view, event, _slice) =>
        handlePaste(view, event as ClipboardEvent, this.pasteParser),
    });

    console.log(`[InLineMd perf]   new EditorView: ${(performance.now() - t2).toFixed(1)}ms`);

    const t3 = performance.now();
    this.manager.initAll(this._view);
    console.log(`[InLineMd perf]   extensions.initAll: ${(performance.now() - t3).toFixed(1)}ms`);

    // Disable native text/node drag — we use our own block drag handles (6-dot grip).
    // External file drops still work (they use 'drop' event, not 'dragstart').
    element.addEventListener('dragstart', (e) => {
      e.preventDefault();
    });

    // Track actual mouse movement to distinguish clicks from drags.
    element.addEventListener('mousedown', () => { _mouseHasMoved = false; }, true);
    element.addEventListener('mousemove', () => { _mouseHasMoved = true; }, true);

    // Direct DOM listener for footnote-label clicks (backup for ProseMirror handleClick
    // which may not fire for contenteditable="false" elements in some browsers)
    element.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.classList.contains('footnote-label') && this._view) {
        const defEl = target.closest('.footnote-def') as HTMLElement;
        if (defEl?.dataset.label) {
          event.preventDefault();
          event.stopPropagation();
          const label = defEl.dataset.label;
          let refPos: number | null = null;
          this._view.state.doc.descendants((n, p) => {
            if (n.type.name === 'footnote_ref' && n.attrs.label === label) {
              refPos = p;
              return false;
            }
          });
          if (refPos !== null) {
            this._view.dispatch(
              this._view.state.tr.setSelection(
                NodeSelection.create(this._view.state.doc, refPos)
              )
            );
            const refDom = this._view.nodeDOM(refPos) as HTMLElement;
            if (refDom) {
              refDom.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
          }
        }
      }
    });
  }

  destroy(): void {
    this.manager.destroyAll();
    this._view?.destroy();
    this._view = null;
  }

  // ── Content management ──

  getMarkdown(): string {
    if (!this._view) return this._currentContent;
    return serializer.serialize(this._view.state.doc, { tightLists: true });
  }

  /**
   * Set content from markdown string.
   * @param isInit - true for initial load (recreates full state with plugins)
   */
  setContent(markdown: string, isInit = false, meta?: Record<string, unknown>): void {
    if (!this._view) return;
    if (markdown === this._currentContent && !isInit) {
      return;
    }

    // Normalize CRLF → LF to prevent \r from leaking into ProseMirror text nodes
    // (e.g. frontmatter YAML). The serializer always produces LF.
    markdown = markdown.replace(/\r\n/g, '\n');

    this._currentContent = markdown;
    this._isUpdatingFromExtension = true;
    let deferCleanup = false;

    try {
      const tParse = performance.now();
      const doc = parseMarkdown(markdown, this.parser);
      if (!doc) return;
      if (isInit) console.log(`[InLineMd perf]   parseMarkdown: ${(performance.now() - tParse).toFixed(1)}ms (${markdown.length} chars)`);

      const tImg = performance.now();
      const converted = this.imageManager.convertImagePaths(doc);
      if (isInit) console.log(`[InLineMd perf]   convertImagePaths: ${(performance.now() - tImg).toFixed(1)}ms`);

      if (isInit) {
        // Fresh state — ensures NodeViews are properly instantiated.
        // Use TextSelection to avoid NodeSelection highlighting non-text nodes (e.g. hr).
        const tState = performance.now();
        let initSelection;
        try { initSelection = TextSelection.atStart(converted); } catch { /* fallback to default */ }
        const newState = EditorState.create({
          doc: converted,
          plugins: this._view.state.plugins,
          ...(initSelection ? { selection: initSelection } : {}),
        });
        console.log(`[InLineMd perf]   EditorState.create: ${(performance.now() - tState).toFixed(1)}ms`);

        const tUpdate = performance.now();
        // Suppress history for any DOM-correction transactions that fire after state update
        this._suppressHistory = true;
        this._view.updateState(newState);
        console.log(`[InLineMd perf]   view.updateState: ${(performance.now() - tUpdate).toFixed(1)}ms`);
        // Defer cleanup — keep _isUpdatingFromExtension and _suppressHistory true
        // until DOM fully settles. Double-RAF covers MutationObserver microtasks
        // that fire async DOM-correction transactions after updateState().
        deferCleanup = true;
        const view = this._view;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            this._suppressHistory = false;
            this._isUpdatingFromExtension = false;
            // Safety: if DOM corrections somehow leaked undo entries despite
            // _suppressHistory, recreate clean state to prevent phantom undo
            if (view && undoDepth(view.state) > 0) {
              console.warn('[EditorCore] Phantom undo entries after init, recreating clean state');
              const cleanState = EditorState.create({
                doc: view.state.doc,
                plugins: view.state.plugins,
                selection: view.state.selection,
              });
              view.updateState(cleanState);
            }
          });
        });
      } else {
        // Patch existing state preserving selection where possible
        const { tr } = this._view.state;
        tr.replaceWith(0, this._view.state.doc.content.size, converted.content);

        // Content from extension should not pollute PM undo stack
        tr.setMeta('addToHistory', false);

        // Attach optional metadata (e.g. externalChange flag)
        if (meta) {
          for (const [key, value] of Object.entries(meta)) {
            tr.setMeta(key, value);
          }
        }

        const maxPos = tr.doc.content.size;
        const { from, to } = this._view.state.selection;
        let selectionSet = false;
        if (from <= maxPos && to <= maxPos) {
          try {
            tr.setSelection(this._view.state.selection.map(tr.doc, tr.mapping));
            selectionSet = true;
          } catch { /* selection mapping failed */ }
        }
        if (!selectionSet) {
          try { tr.setSelection(TextSelection.atStart(tr.doc)); } catch { /* ignore */ }
        }
        tr.scrollIntoView();

        this._view.dispatch(tr);
      }
    } catch (err) {
      console.error('[EditorCore] Failed to parse markdown:', err);
    }

    if (!deferCleanup) {
      this._isUpdatingFromExtension = false;
    }
  }

  // ── Image path management (delegated to EditorImageManager) ──

  setImagePathMap(map: Record<string, string>): void {
    this.imageManager.setImagePathMap(map);
  }

  addImagePath(original: string, webview: string): void {
    this.imageManager.addImagePath(original, webview);
  }

  insertImage(src: string, originalSrc?: string, pos?: number): void {
    if (!this._view) return;
    this.imageManager.insertImage(this._view, src, originalSrc, pos);
  }

  /**
   * Insert one or more images at a specific document position (e.g. from drag & drop).
   */
  insertImagesAtPos(images: Array<{ src: string; originalSrc: string }>, pos: number): void {
    if (!this._view) return;
    this.imageManager.insertImagesAtPos(this._view, images, pos);
  }

  /**
   * Immediately flush any pending debounced content sync.
   * Call this before save to ensure the latest content is sent to the extension.
   */
  flushSync(): void {
    if (this._syncTimer) {
      clearTimeout(this._syncTimer);
      this._syncTimer = null;
      if (!this._view) return;
      try {
        const md = serializer.serialize(this._view.state.doc, { tightLists: true });
        if (md !== this._currentContent) {
          this._currentContent = md;
          this.config.onContentChange?.(md);
        }
      } catch (err) {
        console.warn('[InLineMd] Serialization error in flushSync:', err);
      }
    }
  }

  focus(): void {
    this._view?.focus();
  }

  // ── Private: State creation ──

  private createState(content: string): EditorState {
    const doc = parseMarkdown(content || '', this.parser);
    let initSelection;
    try { initSelection = TextSelection.atStart(doc!); } catch { /* fallback */ }
    return EditorState.create({
      doc: doc!,
      plugins: this.buildPlugins(),
      ...(initSelection ? { selection: initSelection } : {}),
    });
  }

  private buildPlugins() {
    const t0 = performance.now();
    // Extension plugins first — feature keymaps have priority
    const extension = this.manager.buildPlugins(schema);
    console.log(`[InLineMd perf]   buildPlugins (extensions): ${(performance.now() - t0).toFixed(1)}ms`);

    // Core plugins — history (with undo/redo keymaps), drop cursor
    // Note: gap cursor is now handled by BlockEdgeCursorExtension
    // Wrap undo/redo to fall back to cross-mode undo/redo when native stack is exhausted
    const wrappedUndo: typeof undo = (state, dispatch) => {
      if (undo(state, dispatch)) return true;
      if (this.config.onUndoExhausted?.()) return true;
      // Always consume Ctrl+Z — prevent browser native undo from
      // mutating contenteditable DOM when PM has nothing to undo
      return true;
    };
    const wrappedRedo: typeof redo = (state, dispatch) => {
      if (redo(state, dispatch)) return true;
      if (this.config.onRedoExhausted?.()) return true;
      return true;
    };

    const core = [
      history(),
      keymap({
        'Mod-z': wrappedUndo, 'Mod-y': wrappedRedo, 'Mod-Shift-z': wrappedRedo,
        'Mod-Shift-v': (_state, _dispatch, view) => view ? handlePastePlainText(view) : false,
      }),
      dropCursor(),
    ];

    // Host-provided keymaps (Mod-k for link, Mod-s for save, etc.)
    const hostKeymaps = this.config.keymaps
      ? [keymap(this.config.keymaps)]
      : [];

    return [...extension, ...core, ...hostKeymaps];
  }

  // ── Private: Transaction ──

  private _inProxyDispatch = false;
  private _dispatchDepth = 0;

  private dispatch(tr: Transaction): void {
    if (!this._view) return;

    // Suppress history during init — DOM correction transactions shouldn't create undo entries
    if (this._suppressHistory) {
      tr.setMeta('addToHistory', false);
    }

    // Safety net: detect and break re-entrant dispatch loops.
    // This can happen if DOM mutations from plugin views trigger
    // MutationObserver → flush → readDOMChange → dispatch recursion.
    this._dispatchDepth++;
    if (this._dispatchDepth > 3) {
      console.warn('[InLineMd] Re-entrant dispatch loop detected, depth:', this._dispatchDepth);
      this._dispatchDepth--;
      return;
    }

    try {
      // ── Drag-to-select fix ──
      //
      // During mouse drag, ProseMirror's selectionToDOM() calls domSel.collapse()
      // which resets the browser's native drag tracking. Two layers of defence:
      //
      // Layer 1 (all mouse transactions): allowDefault + setCurSelection BEFORE
      //   state.apply(). This refreshes cached selection positions so the Chrome
      //   guard in selectionToDOM sees fresh data. Also freezes decoration plugins
      //   via _isMouseDragging to prevent DOM mutations during docView.update().
      //
      // Layer 2 (actual drag ranges): proxy on currentSelection so the Chrome
      //   guard always compares the DOM selection with itself → guaranteed pass.

      const mouseDown = (this._view as any).input?.mouseDown;
      const isMouseActive = !!(mouseDown && !tr.docChanged);

      // Layer 1: base protection for all mouse-active transactions
      if (isMouseActive) {
        mouseDown.allowDefault = true;
        (this._view as any).domObserver?.setCurSelection();
      }

      _isMouseDragging = isMouseActive;
      const newState = this._view.state.apply(tr);

      // Layer 2: proxy for actual drag ranges (mouse moved + range selection)
      const isDragRange = !!(isMouseActive && _mouseHasMoved && !newState.selection.empty);

      if (isDragRange && !this._inProxyDispatch) {
        const domObserver = (this._view as any).domObserver;
        if (domObserver) {
          const origCurSel = domObserver.currentSelection;
          const liveSel = window.getSelection()!;
          domObserver.currentSelection = {
            get anchorNode() { return liveSel.anchorNode; },
            get anchorOffset() { return liveSel.anchorOffset; },
            get focusNode() { return liveSel.focusNode; },
            get focusOffset() { return liveSel.focusOffset; },
            set(s: any) { origCurSel.set(s); },
            clear() { origCurSel.clear(); },
            eq(s: any) { return origCurSel.eq(s); },
          };
          this._inProxyDispatch = true;
          this._view.updateState(newState);
          this._inProxyDispatch = false;
          domObserver.currentSelection = origCurSel;
          domObserver.setCurSelection();
        } else {
          this._view.updateState(newState);
        }
      } else {
        this._view.updateState(newState);
      }
      _isMouseDragging = false;

      // UI callback
      this.config.onDispatch?.(this._view, tr);

      // Content sync — debounced to avoid race conditions with VS Code applyEdit
      if (!this._isUpdatingFromExtension && tr.docChanged) {
        // Undo/redo transactions (prosemirror-history meta) are local operations.
        // We update _currentContent to keep it in sync, but skip onContentChange
        // to avoid a round-trip through VS Code that disrupts cursor position.
        const isHistoryTr = isHistoryTransaction(tr);
        if (isHistoryTr) {
          // Clear any pending sync timer to prevent stale content from firing
          // after the undo/redo has already updated the document
          if (this._syncTimer) {
            clearTimeout(this._syncTimer);
            this._syncTimer = null;
          }
          try {
            const md = serializer.serialize(this._view.state.doc, { tightLists: true });
            this._currentContent = md;
            this.config.onContentChange?.(md);
          } catch (err) {
            console.warn('[InLineMd] Serialization error in dispatch (history):', err);
          }
        } else {
          if (this._syncTimer) clearTimeout(this._syncTimer);
          this._syncTimer = setTimeout(() => {
            this._syncTimer = null;
            if (!this._view) return;
            try {
              const md = serializer.serialize(this._view.state.doc, { tightLists: true });
              if (md !== this._currentContent) {
                this._currentContent = md;
                this.config.onContentChange?.(md);
              }
            } catch (err) {
              console.warn('[InLineMd] Serialization error in dispatch:', err);
            }
          }, 100);
        }
      }
    } finally {
      this._dispatchDepth--;
    }
  }
}
