/**
 * Keep editor / table / cell scrollports stable across large in-cell pastes.
 */

import type { EditorView } from 'prosemirror-view';
import type { EditorState } from 'prosemirror-state';

type ScrollSnapshot = {
  el: HTMLElement;
  top: number;
  left: number;
};

let suppressScrollToSelectionCount = 0;

export function isScrollToSelectionSuppressed(): boolean {
  return suppressScrollToSelectionCount > 0;
}

export function getSelectionAnchorElement(view: EditorView): HTMLElement | null {
  try {
    const dom = view.domAtPos(view.state.selection.from);
    if (dom.node instanceof HTMLElement) return dom.node;
    return dom.node.parentElement;
  } catch {
    return null;
  }
}

export function captureScrollSnapshots(anchor: HTMLElement | null): ScrollSnapshot[] {
  const seen = new Set<HTMLElement>();
  const snapshots: ScrollSnapshot[] = [];

  const track = (el: HTMLElement | null | undefined) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    snapshots.push({ el, top: el.scrollTop, left: el.scrollLeft });
  };

  track(document.getElementById('editor-scroll-area'));

  let current: HTMLElement | null = anchor;
  while (current) {
    if (
      current.id === 'editor-scroll-area' ||
      current.classList.contains('easyview-table-cell-content') ||
      current.classList.contains('table-scrollable') ||
      current.classList.contains('table-wrapper') ||
      isScrollable(current)
    ) {
      track(current);
    }
    current = current.parentElement;
  }

  return snapshots;
}

export function restoreScrollSnapshots(snapshots: ScrollSnapshot[]): void {
  for (const { el, top, left } of snapshots) {
    if (!el.isConnected) continue;
    if (el.scrollTop !== top) el.scrollTop = top;
    if (el.scrollLeft !== left) el.scrollLeft = left;
  }
}

/**
 * Run a document mutation while pinning nearby scrollports in place.
 * Also suppresses ProseMirror's scroll-to-selection for a couple frames so
 * caret / large inserted content cannot yank the viewport.
 */
export function preserveScrollAround(anchor: HTMLElement | null, run: () => void): void {
  const snapshots = captureScrollSnapshots(anchor);
  suppressScrollToSelectionCount += 1;

  try {
    run();
  } finally {
    scheduleScrollRestore(snapshots);
  }
}

/**
 * Arm scroll pinning for a paste that may continue into ProseMirror's default
 * handler after our handlePaste returns false.
 */
export function pinScrollDuringPaste(anchor: HTMLElement | null): void {
  const snapshots = captureScrollSnapshots(anchor);
  suppressScrollToSelectionCount += 1;
  scheduleScrollRestore(snapshots);
}

function scheduleScrollRestore(snapshots: ScrollSnapshot[]): void {
  restoreScrollSnapshots(snapshots);
  requestAnimationFrame(() => {
    restoreScrollSnapshots(snapshots);
    requestAnimationFrame(() => {
      restoreScrollSnapshots(snapshots);
      setTimeout(() => {
        restoreScrollSnapshots(snapshots);
        suppressScrollToSelectionCount = Math.max(0, suppressScrollToSelectionCount - 1);
      }, 0);
    });
  });
}


/**
 * Keep the active table cell at the same viewport position while a local
 * transaction changes its layout. Saving the old scrollTop alone is not
 * enough: deleting text can shrink a row, which moves the cell away from the
 * caret even when the scroll position itself never changes.
 */
export function preserveTableSelectionViewport(
  view: EditorView,
  run: () => void,
): void {
  const anchor = getSelectionAnchorElement(view);
  const snapshots = captureScrollSnapshots(anchor);
  const editorScrollArea = document.getElementById('editor-scroll-area');
  const selectionBefore = getSelectionViewportPosition(view, editorScrollArea);
  suppressScrollToSelectionCount += 1;

  try {
    run();
  } finally {
    const stabilize = () => {
      // Table / cell scrollports must keep their own horizontal position even
      // if ProseMirror or a browser layout pass tries to follow the caret.
      restoreScrollSnapshots(snapshots);

      if (selectionBefore && editorScrollArea?.isConnected) {
        const selectionAfter = getSelectionViewportPosition(view, editorScrollArea);
        if (selectionAfter) {
          const deltaTop = selectionAfter.top - selectionBefore.top;
          if (Math.abs(deltaTop) > 0.5) {
            editorScrollArea.scrollTop += deltaTop;
          }
        }
      }
    };

    stabilize();
    requestAnimationFrame(() => {
      stabilize();
      requestAnimationFrame(() => {
        stabilize();
        setTimeout(() => {
          stabilize();
          suppressScrollToSelectionCount = Math.max(0, suppressScrollToSelectionCount - 1);
        }, 0);
      });
    });
  }
}

export function isSelectionInsideTableCell(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name === 'table_cell' || name === 'table_header') return true;
  }
  return false;
}

function getSelectionViewportPosition(
  view: EditorView,
  scrollArea: HTMLElement | null,
): { top: number } | null {
  if (!scrollArea) return null;
  try {
    const coords = view.coordsAtPos(view.state.selection.from);
    return { top: coords.top - scrollArea.getBoundingClientRect().top };
  } catch {
    return null;
  }
}

function isScrollable(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  const overflowX = style.overflowX;
  const overflowY = style.overflowY;
  const canX =
    (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay') &&
    el.scrollWidth > el.clientWidth + 1;
  const canY =
    (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
    el.scrollHeight > el.clientHeight + 1;
  return canX || canY;
}
