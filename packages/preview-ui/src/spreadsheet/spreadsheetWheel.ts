/**
 * x-data-spreadsheet scrolls 1 row/col per wheel event. Trackpads fire many
 * small pixel deltas per gesture, so that feels hypersensitive. Normalize to
 * pixel scrollbar movement (Excel-like) and suppress the library handler.
 */

const OVERLAYER_SELECTOR = '.x-spreadsheet-overlayer';
const VERTICAL_SCROLLBAR = '.x-spreadsheet-scrollbar.vertical';
const HORIZONTAL_SCROLLBAR = '.x-spreadsheet-scrollbar.horizontal';

/** Convert a wheel event into CSS-pixel deltas. */
export function wheelEventToPixels(evt: WheelEvent): { dx: number; dy: number } {
  let dx = evt.deltaX;
  let dy = evt.deltaY;
  if (evt.deltaMode === 1) {
    // DOM_DELTA_LINE — approximate a spreadsheet row/col step.
    dx *= 32;
    dy *= 32;
  } else if (evt.deltaMode === 2) {
    // DOM_DELTA_PAGE
    dx *= 800;
    dy *= 600;
  }
  // Shift+wheel often only populates deltaY; treat as horizontal.
  if (evt.shiftKey && Math.abs(dx) < Math.abs(dy)) {
    return { dx: dy, dy: 0 };
  }
  return { dx, dy };
}

function isSpreadsheetOverlayerEvent(evt: Event, mount: HTMLElement): boolean {
  const target = evt.target;
  if (!(target instanceof Element)) return false;
  const overlayer = target.closest(OVERLAYER_SELECTOR);
  return !!overlayer && mount.contains(overlayer);
}

export interface SpreadsheetWheelOptions {
  /**
   * Trackpad pinch / ctrl+wheel zoom. Chromium reports pinch as wheel+ctrlKey;
   * positive deltaY means zoom out. Omit to leave those events alone.
   */
  onZoomDelta?: (deltaY: number) => void;
}

/**
 * Attach capture-phase wheel normalization on a spreadsheet mount.
 * Returns a disposer.
 */
export function attachSpreadsheetWheelNormalization(mount: HTMLElement, options?: SpreadsheetWheelOptions): () => void {
  const onWheel = (evt: WheelEvent) => {
    if (!isSpreadsheetOverlayerEvent(evt, mount)) return;
    const sheet = (evt.target as Element).closest('.x-spreadsheet');
    if (!sheet || !mount.contains(sheet)) return;

    // Pinch-to-zoom: do not scroll.
    if (evt.ctrlKey && options?.onZoomDelta) {
      evt.preventDefault();
      evt.stopImmediatePropagation();
      if (evt.deltaY !== 0) options.onZoomDelta(evt.deltaY);
      return;
    }

    const vertical = sheet.querySelector(VERTICAL_SCROLLBAR) as HTMLElement | null;
    const horizontal = sheet.querySelector(HORIZONTAL_SCROLLBAR) as HTMLElement | null;
    if (!vertical && !horizontal) return;

    evt.preventDefault();
    evt.stopImmediatePropagation();

    const { dx, dy } = wheelEventToPixels(evt);
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    if (absX < 0.01 && absY < 0.01) return;

    // Prefer the dominant axis (same as library), then move scrollbars in pixels.
    if (absX > absY) {
      if (horizontal) horizontal.scrollLeft += dx;
    } else if (vertical) {
      vertical.scrollTop += dy;
    }
  };

  // Legacy mousewheel still fires in Chromium alongside `wheel`; block it so the
  // library's 1-row-per-event handler cannot double-apply.
  const blockLegacy = (evt: Event) => {
    if (!isSpreadsheetOverlayerEvent(evt, mount)) return;
    evt.preventDefault();
    evt.stopImmediatePropagation();
  };

  mount.addEventListener('wheel', onWheel, { capture: true, passive: false });
  mount.addEventListener('mousewheel', blockLegacy, { capture: true, passive: false });
  return () => {
    mount.removeEventListener('wheel', onWheel, true);
    mount.removeEventListener('mousewheel', blockLegacy, true);
  };
}
