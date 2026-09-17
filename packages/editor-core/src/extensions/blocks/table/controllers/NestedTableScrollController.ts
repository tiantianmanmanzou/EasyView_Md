/**
 * Nested Table Scroll Controller
 *
 * Single owner of horizontal-scroll preservation for a table whose own
 * scrollport may sit inside another scrollport (nested table in a cell, table
 * inside the editor scroll area). It captures the scrollLeft of the table's
 * scrollable and all relevant ancestors, and restores them after a layout
 * mutation (column/row resize, width reflow) that would otherwise collapse the
 * viewport to the start.
 */

export interface ScrollSnapshot { el: HTMLElement; left: number }

export class NestedTableScrollController {
  private stableScrollLeft = 0;
  private stableAncestorScrolls = new Map<HTMLElement, number>();
  private pinnedHorizontalScroll: ScrollSnapshot[] | null = null;

  capture(root: HTMLElement | null): ScrollSnapshot[] {
    const snapshots: ScrollSnapshot[] = [];
    const seen = new Set<HTMLElement>();
    const track = (el: HTMLElement | null) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      snapshots.push({ el, left: el.scrollLeft });
    };
    track(root);
    let current = root?.parentElement ?? null;
    while (current) {
      if (current.classList.contains('easyview-table-cell-content') || current.classList.contains('table-scrollable')) track(current);
      current = current.parentElement;
    }
    return snapshots;
  }

  restore(
    snapshots: ScrollSnapshot[] | null,
    onBeforeRestore?: (root: HTMLElement) => void,
    onAfterRestore?: () => void
  ): void {
    if (snapshots) {
      for (const { el, left } of snapshots) {
        if (!el.isConnected || Math.abs(el.scrollLeft - left) <= 0.5) continue;
        onBeforeRestore?.(el);
        el.scrollLeft = left;
      }
    }
    onAfterRestore?.();
  }

  /**
   * Remember the current root offset and ancestor scrollports before a layout
   * mutation. `shouldLock` lets the caller skip learning a new root offset when
   * a column resize is already locking this table's viewport.
   */
  rememberStable(root: HTMLElement | null, shouldLock: () => boolean): void {
    if (!root) return;

    if (!shouldLock()) {
      const left = root.scrollLeft;
      // A decoration/control rebuild can collapse scrollLeft to 0 in the same
      // turn as pointerdown. Do not learn that collapsed value.
      if (!(this.stableScrollLeft > 1 && left < 1)) {
        this.stableScrollLeft = left;
        this.rememberAncestorScrollSnapshots(root);
      }
    }

    this.pinnedHorizontalScroll = this.capture(root).map((snapshot) => {
      if (snapshot.el === root) {
        return { el: snapshot.el, left: this.stableScrollLeft };
      }
      const locked = this.stableAncestorScrolls.get(snapshot.el);
      return locked == null ? snapshot : { el: snapshot.el, left: locked };
    });
  }

  /** Plain horizontal scrolling fast path: only track the root offset. */
  recordRootScrollLeft(root: HTMLElement | null, left: number): void {
    if (!root) return;
    this.stableScrollLeft = left;
  }

  /** Wheel-driven scroll on the root: track root offset plus ancestor offsets. */
  recordRootScrollAndAncestors(root: HTMLElement | null, left: number): void {
    if (!root) return;
    this.stableScrollLeft = left;
    this.rememberAncestorScrollSnapshots(root);
  }

  /** Resize-session scroll on the root: track root, ancestors, and pin snapshots. */
  recordRootScrollAncestorsAndPinned(root: HTMLElement | null, left: number): void {
    if (!root) return;
    this.stableScrollLeft = left;
    this.rememberAncestorScrollSnapshots(root);
    this.pinnedHorizontalScroll = this.capture(root);
  }

  /** True when a DOM mutation collapsed the viewport to the start. */
  hasCollapsedToStart(left: number): boolean {
    return this.stableScrollLeft > 40 && left < 8 && this.stableScrollLeft - left > 40;
  }

  private rememberAncestorScrollSnapshots(root: HTMLElement | null): void {
    this.stableAncestorScrolls.clear();
    for (const snapshot of this.capture(root)) {
      if (snapshot.el === root) continue;
      this.stableAncestorScrolls.set(snapshot.el, snapshot.left);
    }
  }

  private clampScrollLeft(root: HTMLElement | null, left: number): number {
    if (!root) return left;
    const max = Math.max(0, root.scrollWidth - root.clientWidth);
    return Math.min(Math.max(0, left), max);
  }

  /** Bounce the root back to the stable offset after a column-resize commit. */
  restoreColumnResizeScroll(
    root: HTMLElement | null,
    onBeforeRestore?: (root: HTMLElement) => void,
    onAfterRestore?: () => void
  ): void {
    if (!root) return;
    const left = this.clampScrollLeft(root, this.stableScrollLeft);
    if (Math.abs(root.scrollLeft - left) <= 0.5) return;
    onBeforeRestore?.(root);
    root.scrollLeft = left;
    onAfterRestore?.();
  }

  /** Restore root, ancestors, and pinned snapshots after a mutation. */
  restoreStable(
    root: HTMLElement | null,
    onBeforeRestore?: (root: HTMLElement) => void,
    onAfterRestore?: () => void
  ): void {
    if (!root) return;

    const max = Math.max(0, root.scrollWidth - root.clientWidth);
    const applied = Math.min(this.stableScrollLeft, max);
    if (Math.abs(root.scrollLeft - applied) > 0.5) {
      onBeforeRestore?.(root);
      root.scrollLeft = applied;
      onAfterRestore?.();
    }

    for (const [el, left] of this.stableAncestorScrolls) {
      if (el.isConnected && Math.abs(el.scrollLeft - left) > 0.5) {
        el.scrollLeft = left;
      }
    }
    this.restore(this.pinnedHorizontalScroll, onBeforeRestore, onAfterRestore);
  }

  /**
   * Run a layout mutation with scroll positions preserved before and after,
   * including a follow-up restore on the next animation frame.
   */
  withPreserved(
    root: HTMLElement | null,
    shouldLock: () => boolean,
    run: () => void,
    onBeforeRestore?: (root: HTMLElement) => void,
    onAfterRestore?: () => void
  ): void {
    this.rememberStable(root, shouldLock);
    const snapshots = this.capture(root).map((snapshot) => {
      if (snapshot.el === root) {
        return { el: snapshot.el, left: this.stableScrollLeft };
      }
      const locked = this.stableAncestorScrolls.get(snapshot.el);
      return locked == null ? snapshot : { el: snapshot.el, left: locked };
    });
    run();
    this.restore(snapshots, onBeforeRestore, onAfterRestore);
    this.restoreStable(root, onBeforeRestore, onAfterRestore);
    requestAnimationFrame(() => {
      this.restore(snapshots, onBeforeRestore, onAfterRestore);
      this.restoreStable(root, onBeforeRestore, onAfterRestore);
    });
  }
}
