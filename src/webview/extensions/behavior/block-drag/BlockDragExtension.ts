/**
 * BlockDragExtension
 *
 * Adds a drag handle to the left of top-level blocks for reordering.
 *
 * Uses mouse-based drag (mousemove + mouseup) instead of native HTML5 DnD,
 * because Chromium won't initiate native drag from elements inside
 * contentEditable (blocks text selection instead). Mouse-based approach
 * works reliably for all block types including code blocks.
 *
 * Two positioning strategies (same visual result):
 * 1. Regular blocks (paragraph, heading, lists, etc.) — ProseMirror Decoration.widget
 *    inside the block, with stopEvent to prevent contentEditable interference.
 * 2. Special blocks (atom/leaf, details, table) — direct DOM appendChild,
 *    because custom nodeViews / code editing areas interfere with widget decorations.
 *
 * Special handling:
 * - Headings drag their entire "section" (heading + content until next same/higher level heading)
 */

import type { Node as ProsemirrorNode, Schema } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { Extension } from '../../../editor/EditorExtension';
import { pluginKey as mermaidPluginKey } from '../../blocks/mermaid/MermaidPlugin';
import { _isMouseDragging } from '../../../editor/EditorCore';

// ─── SVG Grip Icon ───────────────────────────────────────────────────────────

const GRIP_ICON = `<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
  <circle cx="2.5" cy="2.5" r="1.5"/>
  <circle cx="7.5" cy="2.5" r="1.5"/>
  <circle cx="2.5" cy="8" r="1.5"/>
  <circle cx="7.5" cy="8" r="1.5"/>
  <circle cx="2.5" cy="13.5" r="1.5"/>
  <circle cx="7.5" cy="13.5" r="1.5"/>
</svg>`;

// ─── Heading Section Helper ──────────────────────────────────────────────────

/**
 * Find the end position of a heading's "section" — the heading itself plus
 * all subsequent blocks until the next heading of same or higher level.
 */
function getHeadingSectionEnd(doc: ProsemirrorNode, headingPos: number, level: number): number {
  const headingNode = doc.nodeAt(headingPos)!;
  let sectionEnd = headingPos + headingNode.nodeSize;
  let found = false;
  doc.forEach((node, offset) => {
    if (found || offset <= headingPos) return;
    if (node.type.name === 'heading' && node.attrs.level <= level) {
      found = true;
      return;
    }
    sectionEnd = offset + node.nodeSize;
  });
  return sectionEnd;
}

// ─── Drop Position Helpers ──────────────────────────────────────────────────

/**
 * Find the nearest block boundary for dropping, given a Y coordinate.
 * Skips boundaries inside the dragged range [dragFrom, dragTo].
 *
 * When dragging a heading (headingLevel provided), only allows dropping at
 * section boundaries: before a heading of same/higher level, or at doc edges.
 */
function findDropPos(view: EditorView, clientY: number, dragFrom: number, dragTo: number, headingLevel?: number): number | null {
  const doc = view.state.doc;
  let bestPos: number | null = null;
  let bestDist = Infinity;

  // For heading drags, compute the set of valid (section boundary) positions
  let validPositions: Set<number> | null = null;
  if (headingLevel !== undefined) {
    validPositions = new Set<number>();
    validPositions.add(0);
    validPositions.add(doc.content.size);
    doc.forEach((node, offset) => {
      if (offset >= dragFrom && offset < dragTo) return;
      if (node.type.name === 'heading' && node.attrs.level <= headingLevel) {
        validPositions!.add(offset);
      }
    });
  }

  doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset) as HTMLElement;
    if (!dom) return;
    const blockEnd = offset + node.nodeSize;

    // Use visible bounds (handles hidden mermaid code blocks with widget decorations)
    const top = getVisibleTop(dom);
    const bottom = getVisibleBottom(dom);

    // Top edge = drop before this block
    if (offset <= dragFrom || offset >= dragTo) {
      if (!validPositions || validPositions.has(offset)) {
        const dist = Math.abs(clientY - top);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = offset;
        }
      }
    }

    // Bottom edge = drop after this block
    if (blockEnd <= dragFrom || blockEnd >= dragTo) {
      if (!validPositions || validPositions.has(blockEnd)) {
        const dist = Math.abs(clientY - bottom);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = blockEnd;
        }
      }
    }
  });

  return bestPos;
}

/**
 * Get the visible bottom Y of a block element. If the element is hidden
 * (e.g., mermaid code_block in preview mode), walks forward through siblings
 * to find widget decorations (diagram wrapper, toolbar) and uses their bottom.
 *
 * ProseMirror widget decorations with `side < 0` are rendered as siblings
 * AFTER the code_block element, so we walk forward checking for known widget classes.
 */
function getVisibleBottom(dom: HTMLElement): number {
  const rect = dom.getBoundingClientRect();
  if (rect.height > 0) return rect.bottom;

  let y = rect.bottom;
  let sib = dom.nextElementSibling;
  let count = 0;
  while (sib instanceof HTMLElement && count++ < 10) {
    // Stop at the next ProseMirror content node (not a widget decoration)
    // Widget decorations are divs/spans with specific classes; content nodes are block elements
    const isWidget = sib.classList.contains('mermaid-diagram-wrapper') ||
      sib.classList.contains('mermaid-container-toolbar') ||
      sib.classList.contains('block-drag-handle') ||
      sib.classList.contains('code-block-toolbar');
    if (!isWidget) break;

    const r = sib.getBoundingClientRect();
    if (r.height > 0) y = Math.max(y, r.bottom);
    sib = sib.nextElementSibling;
  }
  return y;
}

/**
 * Get the visible top Y of a block element. If hidden, walks forward to
 * the first visible sibling widget decoration.
 */
function getVisibleTop(dom: HTMLElement): number {
  const rect = dom.getBoundingClientRect();
  if (rect.height > 0) return rect.top;

  let sib = dom.nextElementSibling;
  let count = 0;
  while (sib instanceof HTMLElement && count++ < 10) {
    const r = sib.getBoundingClientRect();
    if (r.height > 0) return r.top;
    sib = sib.nextElementSibling;
  }
  return rect.top;
}

/**
 * Position the drop indicator line at the given document position.
 */
function positionIndicator(view: EditorView, indicator: HTMLElement, dropPos: number) {
  const doc = view.state.doc;
  const editorRect = view.dom.getBoundingClientRect();
  let y = editorRect.top;

  if (dropPos === 0) {
    const dom = view.nodeDOM(0) as HTMLElement;
    if (dom) y = getVisibleTop(dom);
  } else {
    let found = false;
    doc.forEach((node, offset) => {
      if (found) return;
      if (offset + node.nodeSize === dropPos) {
        const dom = view.nodeDOM(offset) as HTMLElement;
        if (dom) y = getVisibleBottom(dom);
        found = true;
      } else if (offset === dropPos) {
        const dom = view.nodeDOM(offset) as HTMLElement;
        if (dom) y = getVisibleTop(dom);
        found = true;
      }
    });
  }

  // Fixed positioning — use viewport coordinates directly
  indicator.style.top = `${y}px`;
  indicator.style.left = `${editorRect.left}px`;
  indicator.style.width = `${editorRect.width}px`;
}

/**
 * Execute the block move: delete from [from, to), insert at dropPos.
 */
function performDrop(view: EditorView, from: number, to: number, dropPos: number) {
  if (dropPos >= from && dropPos <= to) return;

  // Check if document has any mermaid blocks — their widget decorations
  // can cause ProseMirror DOM reconciliation crashes during move operations
  let hasMermaid = false;
  view.state.doc.descendants((node) => {
    if (isMermaidBlock(node)) { hasMermaid = true; return false; }
  });

  const slice = view.state.doc.slice(from, to);
  let tr = view.state.tr;

  if (dropPos <= from) {
    tr = tr.replaceRange(dropPos, dropPos, slice);
    tr = tr.delete(tr.mapping.map(from), tr.mapping.map(to));
  } else {
    tr = tr.delete(from, to);
    tr = tr.replaceRange(tr.mapping.map(dropPos), tr.mapping.map(dropPos), slice);
  }

  if (hasMermaid) {
    // Clear mermaid widget decorations before DOM reconciliation
    tr = tr.setMeta(mermaidPluginKey, { clearForDrop: true });
  }

  view.dispatch(tr);

  if (hasMermaid) {
    // Rebuild mermaid decorations after DOM has settled
    requestAnimationFrame(() => {
      try {
        view.dispatch(view.state.tr.setMeta(mermaidPluginKey, { rebuild: true }));
      } catch { /* view might be destroyed */ }
    });
  }
}

// ─── Block Drag Plugin ───────────────────────────────────────────────────────

const blockDragKey = new PluginKey('blockDrag');

/** Node types that should NOT get a drag handle at all */
const EXCLUDED_TYPES = new Set(['frontmatter']);

/** Check if a code_block is a mermaid diagram */
function isMermaidBlock(node: ProsemirrorNode): boolean {
  return node.type.name === 'code_block' &&
    (node.attrs.language === 'mermaid' || node.attrs.language === 'mermaidjs');
}

/**
 * Node types that need DOM handles (appendChild) instead of Decoration.widget:
 * - details: custom nodeView with collapsible contentDOM — widget hidden when collapsed
 * - table: custom NodeView (TableView) with div wrapper — stable DOM, no ProseMirror patching
 */
const DOM_HANDLE_TYPES = new Set(['details', 'table']);

/** Void HTML elements that cannot have children */
const VOID_ELEMENTS = new Set(['HR', 'BR', 'IMG', 'INPUT']);

function blockDragPlugin(): Plugin {
  let currentView: EditorView | null = null;
  let isDragging = false;
  /** DOM-managed handles for atom/leaf/special blocks */
  let domHandles: HTMLElement[] = [];

  /** Creates a drag handle span wired to the given block position */
  function createHandleElement(pos: number): HTMLElement {
    const handle = document.createElement('span');
    handle.className = 'block-drag-handle';
    handle.contentEditable = 'false';
    handle.innerHTML = GRIP_ICON;
    handle.title = 'Drag to reorder';

    // Mouse-based drag: mousedown → mousemove (threshold) → mouseup (drop)
    // preventDefault on mousedown prevents text selection and native drag,
    // solving both the code-block drag issue and the text-selection issue.
    handle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();

      if (!currentView) return;

      const blockNode = currentView.state.doc.nodeAt(pos);
      if (!blockNode) return;

      const view = currentView;
      const startX = e.clientX;
      const startY = e.clientY;
      let dragActive = false;
      let dropIndicator: HTMLElement | null = null;
      let currentDropPos: number | null = null;

      // Determine drag range (heading sections drag multiple blocks)
      const dragFrom = pos;
      let dragTo = pos + blockNode.nodeSize;
      if (blockNode.type.name === 'heading') {
        dragTo = getHeadingSectionEnd(view.state.doc, pos, blockNode.attrs.level);
      }

      let ghostEl: HTMLElement | null = null;
      const dimmedElements: HTMLElement[] = [];

      const onMouseMove = (moveEvt: MouseEvent) => {
        if (!dragActive) {
          const dx = moveEvt.clientX - startX;
          const dy = moveEvt.clientY - startY;
          if (dx * dx + dy * dy < 25) return; // 5px threshold

          dragActive = true;
          isDragging = true;
          handle.classList.add('dragging');
          view.dom.classList.add('block-dragging');

          // Clear any existing selection to prevent toolbar from appearing
          window.getSelection()?.removeAllRanges();

          // Dim source blocks during drag (including mermaid widget siblings)
          view.state.doc.forEach((node, offset) => {
            if (offset >= dragFrom && offset < dragTo) {
              const dom = view.nodeDOM(offset) as HTMLElement;
              if (dom) {
                dom.style.opacity = '0.3';
                dimmedElements.push(dom);
                // Also dim mermaid widget decorations (siblings after hidden <pre>)
                if (isMermaidBlock(node)) {
                  let sib = dom.nextElementSibling;
                  while (sib instanceof HTMLElement) {
                    const isWidget = sib.classList.contains('mermaid-diagram-wrapper') ||
                      sib.classList.contains('mermaid-container-toolbar') ||
                      sib.classList.contains('block-drag-handle');
                    if (!isWidget) break;
                    sib.style.opacity = '0.3';
                    dimmedElements.push(sib as HTMLElement);
                    sib = sib.nextElementSibling;
                  }
                }
              }
            }
          });

          // Create ghost — semi-transparent clone following the cursor
          const blockDom = view.nodeDOM(pos) as HTMLElement;
          if (blockDom) {
            try {
              const clone = blockDom.cloneNode(true) as HTMLElement;
              // Clean up interactive/control elements from the clone
              clone.querySelectorAll(
                '.block-drag-handle, .table-controls, .table-column-controls, ' +
                '.table-grip, .table-grip-column, .table-grip-row, .table-add-column, .table-add-row, ' +
                '.code-block-toolbar, .heading-actions'
              ).forEach(el => el.remove());
              clone.style.margin = '0';
              clone.style.opacity = '';

              ghostEl = document.createElement('div');
              ghostEl.className = 'block-drag-ghost';
              ghostEl.appendChild(clone);
              ghostEl.style.width = `${Math.min(blockDom.offsetWidth, 500)}px`;
              ghostEl.style.left = `${moveEvt.clientX}px`;
              ghostEl.style.top = `${moveEvt.clientY}px`;
              document.body.appendChild(ghostEl);
            } catch {
              // Ghost creation might fail for complex NodeViews
            }
          }

          // Create drop indicator line (fixed position, in body)
          dropIndicator = document.createElement('div');
          dropIndicator.className = 'block-drop-indicator';
          document.body.appendChild(dropIndicator);
        }

        // Move ghost with cursor
        if (ghostEl) {
          ghostEl.style.left = `${moveEvt.clientX}px`;
          ghostEl.style.top = `${moveEvt.clientY}px`;
        }

        // Update drop position (headings restricted to section boundaries)
        const headingLvl = blockNode.type.name === 'heading' ? blockNode.attrs.level : undefined;
        const newDropPos = findDropPos(view, moveEvt.clientY, dragFrom, dragTo, headingLvl);
        if (newDropPos !== null && newDropPos !== currentDropPos) {
          currentDropPos = newDropPos;
          if (dropIndicator) {
            positionIndicator(view, dropIndicator, currentDropPos);
          }
        }
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        if (dragActive && currentDropPos !== null) {
          performDrop(view, dragFrom, dragTo, currentDropPos);
        }

        // Cleanup
        isDragging = false;
        handle.classList.remove('dragging');
        view.dom.classList.remove('block-dragging');
        if (dropIndicator) {
          dropIndicator.remove();
        }
        if (ghostEl) {
          ghostEl.remove();
          ghostEl = null;
        }
        for (const el of dimmedElements) {
          el.style.opacity = '';
        }
        dimmedElements.length = 0;
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    return handle;
  }

  /** Whether a node should use DOM handles instead of decoration widgets */
  function needsDomHandle(node: ProsemirrorNode): boolean {
    return node.isLeaf || node.isAtom || DOM_HANDLE_TYPES.has(node.type.name);
  }

  /** Widget decorations for regular blocks */
  function createDecorations(doc: ProsemirrorNode): DecorationSet {
    const decorations: Decoration[] = [];

    doc.forEach((node, pos) => {
      if (EXCLUDED_TYPES.has(node.type.name)) return;
      if (node.type.name === 'paragraph' && node.content.size === 0) return;

      // Mermaid code_blocks: place handle AFTER the code block (alongside diagram widget)
      // positioned absolutely relative to .ProseMirror to overlap the diagram wrapper
      if (isMermaidBlock(node)) {
        decorations.push(
          Decoration.widget(
            pos + node.nodeSize,
            () => {
              const handle = createHandleElement(pos);
              // Position via rAF after diagram wrapper is in DOM
              const positionHandle = () => {
                let prev = handle.previousElementSibling;
                while (prev && !prev.classList.contains('mermaid-diagram-wrapper')) {
                  prev = prev.previousElementSibling;
                }
                if (prev && prev instanceof HTMLElement) {
                  handle.style.top = `${prev.offsetTop + 4}px`;
                  handle.style.left = `${prev.offsetLeft - 28}px`;
                  handle.style.marginLeft = '0';
                  return true;
                }
                return false;
              };
              // Retry positioning — diagram may render asynchronously
              let retries = 0;
              const tryPosition = () => {
                if (!positionHandle() && retries++ < 10) {
                  setTimeout(tryPosition, 200);
                }
              };
              requestAnimationFrame(tryPosition);
              return handle;
            },
            { side: -9, ignoreSelection: true, stopEvent: () => true, key: `drag-mermaid-${pos}` }
          )
        );
        return;
      }

      if (needsDomHandle(node)) return;

      decorations.push(
        Decoration.widget(
          pos + 1,
          () => createHandleElement(pos),
          { side: -1, ignoreSelection: true, stopEvent: () => true, key: `drag-${pos}` }
        )
      );
    });

    return DecorationSet.create(doc, decorations);
  }

  /** Direct DOM handles for atom/leaf/special blocks + mermaid diagrams */
  function syncDomHandles(view: EditorView) {
    for (const h of domHandles) h.remove();
    domHandles = [];

    view.state.doc.forEach((node, pos) => {
      if (EXCLUDED_TYPES.has(node.type.name)) return;
      if (node.type.name === 'paragraph' && node.content.size === 0) return;

      // Mermaid code_blocks handled via Decoration.widget in createDecorations
      if (isMermaidBlock(node)) return;

      if (!needsDomHandle(node)) return;

      const dom = view.nodeDOM(pos);
      if (!dom || !(dom instanceof HTMLElement)) return;
      if (VOID_ELEMENTS.has(dom.tagName)) return;

      dom.style.position = 'relative';
      const handle = createHandleElement(pos);
      // Table wrapper has 40px padding-top for column grips — offset handle accordingly
      if (node.type.name === 'table') {
        handle.style.top = '44px';
      }
      dom.appendChild(handle);
      domHandles.push(handle);
    });
  }

  return new Plugin({
    key: blockDragKey,
    state: {
      init(_, { doc }) {
        return createDecorations(doc);
      },
      apply(tr, set) {
        if (tr.docChanged) {
          return createDecorations(tr.doc);
        }
        return set;
      },
    },
    view(view) {
      currentView = view;
      let domSyncRaf: number | null = null;

      // Initial sync after nodeViews and decoration widgets have rendered
      setTimeout(() => syncDomHandles(view), 0);

      return {
        update(view, prevState) {
          currentView = view;
          // Skip DOM mutations during mouse drag to preserve native selection
          if (_isMouseDragging) return;
          if (view.state.doc !== prevState.doc) {
            // Doc changed: sync immediately, wrapped in domObserver.stop()/start()
            // to prevent MutationObserver from seeing our DOM changes.
            if (domSyncRaf) { cancelAnimationFrame(domSyncRaf); domSyncRaf = null; }
            const obs = (view as any).domObserver;
            obs?.stop();
            syncDomHandles(view);
            obs?.start();
          } else {
            // Decorations may have changed (e.g. mermaid diagram widgets created) —
            // schedule a deferred sync to pick up new DOM elements
            if (!domSyncRaf) {
              domSyncRaf = requestAnimationFrame(() => {
                domSyncRaf = null;
                // Async DOM mutations also need observer protection
                const obs2 = (view as any).domObserver;
                obs2?.stop();
                syncDomHandles(view);
                obs2?.start();
              });
            }
          }
        },
        destroy() {
          currentView = null;
          for (const h of domHandles) h.remove();
          domHandles = [];
        },
      };
    },
    props: {
      decorations(state) {
        return blockDragKey.getState(state);
      },
    },
  });
}

// ─── Extension ───────────────────────────────────────────────────────────────

export class BlockDragExtension extends Extension {
  get name() {
    return 'blockDrag';
  }

  plugins(_schema: Schema): Plugin[] {
    return [blockDragPlugin()];
  }
}
