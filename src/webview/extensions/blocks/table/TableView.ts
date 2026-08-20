/**
 * TableView — ProseMirror NodeView for tables
 *
 * Creates table wrapper with controls as DOM elements (not decorations)
 * This approach avoids the content-shifting issues with widget decorations.
 */

import type { Node as ProsemirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import {
  TableView as ProsemirrorTableView,
  TableMap,
  columnResizingPluginKey,
  updateColumnsOnResize,
} from 'prosemirror-tables';
import { TableStyleHelper } from './TableStyleHelper';
import * as tableCommands from './TableCommands';
import { getEditorView } from '../../../index';
import { TableGripToolbar } from './TableGripToolbar';
import { syncTableCellVerticalAlignmentLayout } from './TableCellView';
import { isColumnSelection, isRowSelection, isTableSelected } from './TableQueries';

export class TableView extends ProsemirrorTableView {
  private scrollable: HTMLDivElement | null = null;
  private controlsContainer: HTMLDivElement | null = null;
  private columnControlsContainer: HTMLDivElement | null = null;
  private gripToolbar: TableGripToolbar | null = null;
  private stickyHeaderOverlay: HTMLDivElement | null = null;
  private stickyHeaderFrame: number | null = null;
  private stickyHeaderObserver: MutationObserver | null = null;
  private toolbarRequest: {
    type: 'row' | 'column' | 'table';
    index: number;
  } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private layoutSyncFrame: number | null = null;
  private lastObservedTableSize: { width: number; height: number } | null = null;
  private renderedRowHeightCache = new WeakMap<HTMLTableRowElement, number | null>();
  private rowResizeCleanup: (() => void) | null = null;
  private isRowResizing = false;
  private lastRowResizeHover: number | null | undefined = undefined;
  private pinnedHorizontalScroll: Array<{ el: HTMLElement; left: number }> | null = null;
  private stableScrollLeft = 0;
  private stableAncestorScrolls = new Map<HTMLElement, number>();
  private ignoringScrollEvent = false;
  private columnResizeSession = false;
  private columnResizeCommitPending = false;
  // Widths that are rendered but not yet persisted in ProseMirror's colwidth
  // attrs. The resize plugin commits only the resized logical column, so these
  // keep the remaining columns stable when the table enters fixed-width mode.
  private manualColumnWidthSnapshot: number[] | null = null;
  private readonly minRowHeight = 36;
  private readonly maxRowHeight = 1200;
  // Double-clicking a column divider restores a predictable compact width.
  // Keep it above the resize plugin's hard minimum so the column remains
  // editable and can still be dragged normally afterwards.
  private readonly compactColumnWidth = 100;
  // Keep the table-select dot off the row/column dashed bars and the table's
  // rectangular corner so it stays easy to see and click, including nested tables.
  private readonly tableGripSize = 14;
  private readonly tableGripLeftOffset = 30;
  private readonly tableGripTopOffset = 22;
  private readonly columnControlBandHeight = 8;
  private readonly columnGripInsetTop = 2;
  private readonly columnGripHeight = 4;
  private readonly scheduleLayoutSync = (): void => {
    if (this.layoutSyncFrame !== null || this.isRowResizing || this.shouldDeferColumnResizeLayout()) return;
    // Hover/drag already mutates <col> widths. Extra layout here restyles
    // every table on the page and is what users see as screen flicker.
    if (this.shouldDeferColumnResizeLayout()) return;

    this.layoutSyncFrame = requestAnimationFrame(() => {
      this.layoutSyncFrame = null;
      if (!this.dom || !this.node || this.isRowResizing || this.shouldDeferColumnResizeLayout()) return;

      this.withPreservedHorizontalScroll(() => {
        this.syncWrappedColumnWidths();
        this.applyRowHeights(this.node);
        this.updateClassList(this.node);
        this.syncStickyHeader(this.node);
        // ResizeObserver fires for ordinary content reflow as well as real
        // table structure changes. Recreating every grip on each delivery
        // causes a large child-list mutation burst and visible scroll jank.
        // Keep existing controls and update only their geometry unless rows or
        // logical columns actually changed.
        this.refreshControlGeometryOrRebuild(this.node);
      });
    });
  };
  private readonly handleTableWrapLayoutChange = (): void => {
    this.scheduleLayoutSync();
  };

  private readonly handleEditorScrollForStickyHeader = (): void => {
    this.scheduleStickyHeaderLayout();
  };
  private readonly clearRowResizeCursor = (): void => {
    if (this.isRowResizing) return;
    this.table.classList.remove('easyview-row-resize-ready');
    if (this.lastRowResizeHover !== null) {
      this.lastRowResizeHover = null;
      this.logRowResize('leave', {});
    }
  };
  private readonly handleTablePointerMove = (event: PointerEvent): void => {
    // Events from a nested table also hit the ancestor TableView. The outer
    // table must not run geometry / control work or it janks the whole page.
    if (this.isEventFromNestedTable(event.target)) return;

    if (this.isRowResizing || this.isTableControlTarget(event.target)) return;
    const rowIndex = this.getRowIndexAtHorizontalBorder(event.clientY);
    this.table.classList.toggle('easyview-row-resize-ready', rowIndex !== null);
    if (rowIndex !== this.lastRowResizeHover) {
      this.lastRowResizeHover = rowIndex;
    }
  };
  private readonly handleScrollableScroll = (): void => {
    if (!this.scrollable || this.ignoringScrollEvent) return;

    const left = this.scrollable.scrollLeft;
    this.scheduleStickyHeaderLayout();
    // Normal horizontal scrolling must stay on the compositor fast path. The
    // snapshot walk below reads every ancestor scrollport and is only needed
    // while a column-resize commit may mutate layout beneath the viewport.
    if (!this.columnResizeSession && !this.columnResizeCommitPending) {
      this.stableScrollLeft = left;
      return;
    }
    // Only bounce back when a DOM mutation collapsed the viewport to the
    // start. Never fight an intentional scrollbar / wheel move to the right.
    const collapsedToStart =
      this.stableScrollLeft > 40 && left < 8 && this.stableScrollLeft - left > 40;
    if (collapsedToStart && this.columnResizeSession) {
      this.restoreColumnResizeScroll();
      return;
    }

    this.stableScrollLeft = left;
    this.rememberAncestorScrollSnapshots();
    this.pinnedHorizontalScroll = this.captureHorizontalScrollSnapshots();
  };
  private readonly handleTablePointerDown = (event: PointerEvent): void => {
    // The add-row / add-column handles intentionally sit on a table border.
    // They are descendants of this wrapper, so the capture-phase row-resize
    // listener used to claim their pointerdown before their own mousedown
    // command could run. Let control handles keep ownership of their clicks.
    if (event.button !== 0 || !event.isPrimary || this.isRowResizing || this.isTableControlTarget(event.target)) return;
    // Nested column-resize events bubble through ancestor wrappers. An outer
    // table must not start a row-height drag from that Y hit; committing the
    // then-tall nested layout leaves a permanent empty band under the nested
    // table after its columns get wider and wrap less.
    if (this.isEventFromNestedTable(event.target)) return;
    if (this.isOnHorizontalScrollbar(event)) return;
    if (this.isColumnResizeInteractionOnThisTable()) return;
    if (this.isNearColumnDivider(event)) return;
    const rowIndex = this.getRowIndexAtHorizontalBorder(event.clientY);
    this.logRowResize('mouseDown', {
      clientY: event.clientY,
      rowIndex,
      target: this.describeTarget(event.target),
      rows: this.getRowGeometry(),
    });
    if (rowIndex === null) return;

    const row = this.getDirectRows()[rowIndex];
    if (!row) return;
    this.startRowResize(event, rowIndex, row.getBoundingClientRect().height);
  };
  private readonly handleTableWheel = (event: WheelEvent): void => {
    if (!this.scrollable || !(event.target instanceof HTMLElement)) return;
    // Wheel events cross every ancestor in capture phase. Handle the gesture
    // only on the nearest table so an outer TableView cannot steal a nested
    // cell's own overflow viewport (code, long prose).
    if (event.target.closest('.table-wrapper') !== this.dom) return;

    const horizontalDelta =
      Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (horizontalDelta === 0) return;

    const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? Math.max(1, this.scrollable.clientWidth)
        : 1;
    let remaining = horizontalDelta * deltaScale;
    if (remaining === 0) return;

    const owners = this.collectHorizontalWheelScrollOwners(event.target);
    let applied = false;
    this.ignoringScrollEvent = true;
    for (const owner of owners) {
      const maxScrollLeft = Math.max(0, owner.scrollWidth - owner.clientWidth);
      if (maxScrollLeft <= 1) continue;
      const nextLeft = Math.min(maxScrollLeft, Math.max(0, owner.scrollLeft + remaining));
      const consumed = nextLeft - owner.scrollLeft;
      if (Math.abs(consumed) < 0.5) continue;
      owner.scrollLeft = nextLeft;
      remaining -= consumed;
      applied = true;
      if (owner === this.scrollable) {
        this.stableScrollLeft = nextLeft;
        this.rememberAncestorScrollSnapshots();
      }
      if (Math.abs(remaining) < 0.5) break;
    }
    this.ignoringScrollEvent = false;

    if (!applied) return;
    event.preventDefault();
    event.stopPropagation();
  };

  private isHorizontalScrollPort(element: HTMLElement): boolean {
    const overflowX = getComputedStyle(element).overflowX;
    return (
      (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'overlay') &&
      element.scrollWidth - element.clientWidth > 1
    );
  }

  /**
   * Inner overflowing cell/code viewports first, then nested table scrollports,
   * then the outer table. Remaining delta after a port hits its edge is applied
   * to the next owner so nested-table overscroll continues the host table.
   */
  private collectHorizontalWheelScrollOwners(target: HTMLElement): HTMLElement[] {
    const chain: HTMLElement[] = [];
    const root = document.getElementById('editor-scroll-area');
    let current: HTMLElement | null = target;
    while (current && current !== root) {
      if (this.isHorizontalScrollPort(current)) chain.push(current);
      current = current.parentElement;
    }

    const contentPorts: HTMLElement[] = [];
    const tablePorts: HTMLElement[] = [];
    for (const element of chain) {
      if (element.classList.contains('table-scrollable')) {
        tablePorts.push(element);
        continue;
      }
      if (
        element.classList.contains('easyview-table-cell-content') &&
        element.querySelector(':scope > .table-wrapper')
      ) {
        continue;
      }
      contentPorts.push(element);
    }

    return [...contentPorts, ...tablePorts];
  }
  private readonly handleTableMouseDownCapture = (event: MouseEvent): void => {
    if (this.compactColumnOnDoublePress(event)) return;
    if (this.isEventFromNestedTable(event.target) || this.isOnHorizontalScrollbar(event)) return;
    // The table-resize plugin has already selected the handle on hover. Lock
    // only its owning table; ordinary cell clicks and ancestor tables do not
    // participate in the nested table's scroll preservation.
    if (!this.isColumnResizeInteractionOnThisTable()) return;
    this.rememberStableHorizontalScroll();
    this.columnResizeSession = true;
    if (this.layoutSyncFrame !== null) {
      cancelAnimationFrame(this.layoutSyncFrame);
      this.layoutSyncFrame = null;
    }
  };
  /**
   * Browsers report the second press of a double-click before they dispatch
   * `dblclick`. The resize plugin prevents the native mouse event while it
   * starts a drag, which makes a `dblclick` listener unreliable. Handle the
   * second press instead, before the plugin can start another drag.
   */
  private compactColumnOnDoublePress(event: MouseEvent): boolean {
    if (
      event.detail !== 2 ||
      event.button !== 0 ||
      this.isEventFromNestedTable(event.target) ||
      this.isOnHorizontalScrollbar(event)
    ) {
      return false;
    }

    const view = getEditorView();
    const pluginState = view ? columnResizingPluginKey.getState(view.state) : null;
    if (!view || pluginState?.dragging) return false;

    const cellPos = this.getColumnResizeCellAtEvent(view, event);
    if (cellPos < 0) return false;

    // Do not let prosemirror-tables begin a second resize session. It is
    // important to stop this specific press only: ordinary single-clicks and
    // all existing column drag behavior continue through unchanged.
    event.preventDefault();
    event.stopImmediatePropagation();
    this.withPreservedHorizontalScroll(() => {
      this.setColumnWidth(view, cellPos, Math.max(this.defaultCellMinWidth, this.compactColumnWidth));
    });

    requestAnimationFrame(() => {
      if (!this.node) return;
      this.restoreStableHorizontalScroll();
      this.refreshColumnControlGeometry(this.node);
      this.updateClassList(this.node);
    });
    return true;
  }

  private readonly handleTableMouseUpCapture = (): void => {
    if (!this.columnResizeSession) return;
    this.columnResizeSession = false;
    // `prosemirror-tables` commits the cell attrs in its window mouseup handler.
    // Do not rebuild the controls after that commit: clearing/re-appending each
    // grip causes a full webview repaint and was the visible flash. A column
    // resize only changes horizontal geometry, so update the existing controls
    // in place after the commit instead.
    this.columnResizeCommitPending = true;
    requestAnimationFrame(() => {
      this.restoreColumnResizeScroll();
      if (this.node) this.refreshColumnControlGeometry(this.node);
      this.updateClassList(this.node);
      this.columnResizeCommitPending = false;
    });
  };

  constructor(node: ProsemirrorNode, cellMinWidth: number, _view?: EditorView) {
    super(node, cellMinWidth);

    // Remove table from default dom and wrap in scrollable container
    this.dom.removeChild(this.table);
    this.dom.className = TableStyleHelper.table;

    // Create scrollable wrapper
    this.scrollable = this.dom.appendChild(document.createElement('div'));
    this.scrollable.className = TableStyleHelper.tableScrollable;

    // Create column controls container (INSIDE scrollable - scrolls with table)
    this.columnControlsContainer = this.scrollable.appendChild(document.createElement('div'));
    this.columnControlsContainer.className = 'table-column-controls';
    this.columnControlsContainer.contentEditable = 'false';
    this.columnControlsContainer.setAttribute('oncontextmenu', 'return false');

    // Add table after column controls
    this.scrollable.appendChild(this.table);
    this.scrollable.style.overflowAnchor = 'none';
    this.scrollable.addEventListener('scroll', this.handleScrollableScroll, { passive: true });
    document.getElementById('editor-scroll-area')?.addEventListener('scroll', this.handleEditorScrollForStickyHeader, { passive: true });

    // Row controls live inside the same scrollport as the table so the left
    // border markers follow horizontal scroll on both nested and outer tables.
    this.controlsContainer = this.scrollable.appendChild(document.createElement('div'));
    this.controlsContainer.className = 'table-controls';
    this.controlsContainer.contentEditable = 'false';
    this.controlsContainer.setAttribute('oncontextmenu', 'return false');

    // Initialize grip toolbar
    this.gripToolbar = new TableGripToolbar();

    // Close toolbar when clicking inside table cells
    this.table.addEventListener('mousedown', (e) => {
      // Only close if clicking on a cell, not on grips or buttons
      const target = e.target as HTMLElement;
      if (target.tagName === 'TD' || target.tagName === 'TH' || target.closest('td') || target.closest('th')) {
        if (this.gripToolbar) {
          this.gripToolbar.hide();
        }
      }
    });

    // Detect row resizing from the actual rendered horizontal borders. This is
    // independent of wrapper controls, so its hit area stays aligned after a
    // wide table scrolls or a row's content changes size.
    // Use capture-phase Pointer Events on the wrapper. The normal ProseMirror
    // mouse handlers can claim a cell mousedown before a table-level bubble
    // listener sees it. Pointer capture guarantees that a drag keeps updating
    // even after the pointer leaves the table or webview content area.
    this.dom.addEventListener('pointermove', this.handleTablePointerMove, true);
    this.dom.addEventListener('pointerleave', this.clearRowResizeCursor, true);
    this.dom.addEventListener('pointerdown', this.handleTablePointerDown, true);
    this.dom.addEventListener('mousedown', this.handleTableMouseDownCapture, true);
    this.dom.addEventListener('mouseup', this.handleTableMouseUpCapture, true);
    window.addEventListener('mouseup', this.handleTableMouseUpCapture, true);
    this.dom.addEventListener('wheel', this.handleTableWheel, {
      capture: true,
      passive: false,
    });

    // Create controls
    this.syncWrappedColumnWidths();
    this.applyRowHeights(node);
    this.updateControls(node);

    this.updateClassList(node);
    this.syncStickyHeader(node);
    window.addEventListener('easyview-table-wrap-layout-change', this.handleTableWrapLayoutChange);

    // Wait for DOM to render to ensure scroll shadows are correct
    setTimeout(() => {
      if (this.dom) {
        this.scheduleLayoutSync();
      }
    }, 100);

    // ResizeObserver: update grips when table dimensions change (e.g. column resize)
    this.resizeObserver = new ResizeObserver((entries) => {
      if (this.shouldDeferColumnResizeLayout()) return;
      const entry = entries.find((candidate) => candidate.target === this.table);
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const previous = this.lastObservedTableSize;
      // Ignore duplicate deliveries from ResizeObserver. They are common after
      // a style write, and each one used to remeasure every cell and repaint
      // all table controls even when the rendered table did not change.
      if (previous && Math.abs(previous.width - width) < 0.5 && Math.abs(previous.height - height) < 0.5) {
        return;
      }
      this.lastObservedTableSize = { width, height };
      this.scheduleLayoutSync();
    });
    this.resizeObserver.observe(this.table);
  }

  override update(node: ProsemirrorNode): boolean {
    const nodeChanged = node !== this.node;
    // Plugin-state-only transactions (hovering a column edge, leaving it,
    // selection changes) retain the exact same table node. ProseMirror invokes
    // every table NodeView for them, including all ancestors of a nested table.
    // Calling the parent update in that case rewrites <col> widths even though
    // no table data changed; the resulting nested viewport reflow clamps a
    // later-column scroll position back to zero. There is nothing to reconcile
    // for an unchanged node, so keep the existing DOM intact. A real column
    // resize commits a new node on mouseup and follows the normal path below.
    if (!nodeChanged) return true;

    // `super.update()` calls prosemirror-tables' updateColumnsOnResize(), which
    // clears the DOM width of every column that has no persisted colwidth.
    // Snapshot their actual width first, while the browser can still report it.
    const renderedWidths = nodeChanged ? this.captureRenderedColumnWidths() : null;
    const result = super.update(node);
    if (renderedWidths) this.manualColumnWidthSnapshot = renderedWidths;
    if (result) {
      // Apply committed row heights immediately. Waiting for a later animation
      // frame leaves a visible window where ProseMirror has replaced the row
      // DOM but the fixed cell viewports have not been restored yet.
      if (!this.isRowResizing && !this.shouldDeferColumnResizeLayout()) {
        this.applyRowHeights(node);
      }

      // Keep the remaining geometry/control synchronization deferred so table
      // width writes cannot feed back into ResizeObserver delivery.
      this.syncStickyHeader(node);
      this.scheduleLayoutSync();
    }
    return result;
  }

  /**
   * The horizontal table scrollport is intentionally overflow-x:auto. Chromium
   * treats that ancestor as the sticky containing block even when overflow-y is
   * hidden, so a CSS-only sticky cell cannot follow #editor-scroll-area. Render
   * a passive fixed clone while the real first row is above the editor viewport.
   * The original cells remain editable; the clone never receives pointer input.
   */
  private syncStickyHeader(node: ProsemirrorNode): void {
    const firstRow = node.firstChild;
    const shouldStick = firstRow?.attrs.sticky === true;
    if (!shouldStick) {
      this.removeStickyHeader();
      return;
    }

    if (!this.stickyHeaderOverlay) {
      const overlay = document.createElement('div');
      overlay.className = 'easyview-sticky-table-header';
      overlay.contentEditable = 'false';
      overlay.setAttribute('aria-hidden', 'true');
      document.body.appendChild(overlay);
      this.stickyHeaderOverlay = overlay;
      this.stickyHeaderObserver = new MutationObserver(() => this.scheduleStickyHeaderLayout(true));
      this.stickyHeaderObserver.observe(this.table, { childList: true, subtree: true, characterData: true });
    }

    this.renderStickyHeaderClone();
    this.scheduleStickyHeaderLayout();
  }

  private renderStickyHeaderClone(): void {
    const overlay = this.stickyHeaderOverlay;
    const firstRow = this.getDirectRows()[0];
    if (!overlay || !firstRow) return;

    const sourceTableRect = this.table.getBoundingClientRect();
    const cloneTable = document.createElement('table');
    cloneTable.className = `${this.table.className} easyview-sticky-table`.trim();
    this.copyStickyHeaderTableStyles(this.table, cloneTable, sourceTableRect.width);

    const colgroup = this.table.querySelector(':scope > colgroup')?.cloneNode(true) as HTMLElement | undefined;
    if (colgroup) cloneTable.appendChild(colgroup);
    const tbody = document.createElement('tbody');
    const cloneRow = firstRow.cloneNode(true) as HTMLTableRowElement;
    this.copyStickyHeaderRowStyles(firstRow, cloneRow);
    tbody.appendChild(cloneRow);
    cloneTable.appendChild(tbody);
    overlay.replaceChildren(cloneTable);
  }


  /** Apply only measured presentation properties to the inert clone. The clone
   * is appended to body, so .ProseMirror-scoped rules would otherwise not apply. */
  private copyStickyHeaderTableStyles(source: HTMLTableElement, clone: HTMLTableElement, width: number): void {
    const style = getComputedStyle(source);
    clone.style.boxSizing = 'border-box';
    clone.style.width = `${width}px`;
    clone.style.minWidth = `${width}px`;
    clone.style.maxWidth = `${width}px`;
    clone.style.tableLayout = style.tableLayout;
    clone.style.borderCollapse = style.borderCollapse;
    clone.style.borderSpacing = style.borderSpacing;
    clone.style.border = style.border;
    clone.style.borderLeft = style.borderLeft;
    clone.style.borderRight = style.borderRight;
    clone.style.borderTop = style.borderTop;
    clone.style.borderBottom = style.borderBottom;
    clone.style.borderRadius = style.borderRadius;
    clone.style.color = style.color;
    clone.style.fontFamily = style.fontFamily;
    clone.style.fontSize = style.fontSize;
    clone.style.fontWeight = style.fontWeight;
    clone.style.lineHeight = style.lineHeight;
    clone.style.backgroundColor = 'transparent';
  }

  private copyStickyHeaderRowStyles(source: HTMLTableRowElement, clone: HTMLTableRowElement): void {
    const tableStyle = getComputedStyle(this.table);
    const sourceCells = Array.from(source.children).filter((cell): cell is HTMLTableCellElement =>
      cell instanceof HTMLTableCellElement
    );
    const cloneCells = Array.from(clone.children).filter((cell): cell is HTMLTableCellElement =>
      cell instanceof HTMLTableCellElement
    );
    sourceCells.forEach((sourceCell, index) => {
      const cloneCell = cloneCells[index];
      if (!cloneCell) return;
      const sourceStyle = getComputedStyle(sourceCell);
      const sourceRect = sourceCell.getBoundingClientRect();
      const isLastCell = index === sourceCells.length - 1;
      // Preserve cell boundaries and the computed ProseMirror table presentation.
      cloneCell.style.boxSizing = 'border-box';
      cloneCell.style.width = `${sourceRect.width}px`;
      cloneCell.style.minWidth = `${sourceRect.width}px`;
      cloneCell.style.maxWidth = `${sourceRect.width}px`;
      cloneCell.style.height = `${sourceRect.height}px`;
      cloneCell.style.padding = sourceStyle.padding;
      cloneCell.style.borderTop = sourceStyle.borderTop;
      cloneCell.style.borderBottom = sourceStyle.borderBottom;
      cloneCell.style.borderLeft = sourceStyle.borderLeft;
      cloneCell.style.borderRight = isLastCell && parseFloat(sourceStyle.borderRightWidth) === 0
        ? tableStyle.borderRight
        : sourceStyle.borderRight;
      cloneCell.style.borderTopLeftRadius = sourceStyle.borderTopLeftRadius;
      cloneCell.style.borderTopRightRadius = sourceStyle.borderTopRightRadius;
      cloneCell.style.backgroundColor = sourceStyle.backgroundColor;
      cloneCell.style.color = sourceStyle.color;
      cloneCell.style.fontFamily = sourceStyle.fontFamily;
      cloneCell.style.fontSize = sourceStyle.fontSize;
      cloneCell.style.fontWeight = sourceStyle.fontWeight;
      cloneCell.style.fontStyle = sourceStyle.fontStyle;
      cloneCell.style.lineHeight = sourceStyle.lineHeight;
      cloneCell.style.textAlign = 'center';
      cloneCell.style.verticalAlign = 'middle';
      cloneCell.style.whiteSpace = sourceStyle.whiteSpace;

      const cloneContent = cloneCell.querySelector(':scope > .easyview-table-cell-content') as HTMLElement | null;
      if (cloneContent) {
        cloneContent.style.display = 'flex';
        cloneContent.style.flexDirection = 'column';
        cloneContent.style.justifyContent = 'center';
        cloneContent.style.alignItems = 'center';
        cloneContent.style.boxSizing = 'border-box';
        cloneContent.style.width = '100%';
        cloneContent.style.height = '100%';
        cloneContent.style.textAlign = 'center';
        cloneContent.style.background = 'inherit';
      }
    });
  }

  private scheduleStickyHeaderLayout(refreshClone = false): void {
    if (this.stickyHeaderFrame !== null) return;
    this.stickyHeaderFrame = requestAnimationFrame(() => {
      this.stickyHeaderFrame = null;
      if (refreshClone) this.renderStickyHeaderClone();
      this.layoutStickyHeader();
    });
  }

  private layoutStickyHeader(): void {
    const overlay = this.stickyHeaderOverlay;
    const scrollArea = document.getElementById('editor-scroll-area');
    const firstRow = this.getDirectRows()[0];
    if (!overlay || !scrollArea || !firstRow) return;

    const scrollRect = scrollArea.getBoundingClientRect();
    const tableRect = this.table.getBoundingClientRect();
    const rowRect = firstRow.getBoundingClientRect();
    const visible = rowRect.top < scrollRect.top && tableRect.bottom > scrollRect.top + rowRect.height;
    if (!visible) {
      overlay.style.display = 'none';
      return;
    }

    overlay.style.display = 'block';
    overlay.style.left = `${tableRect.left}px`;
    overlay.style.top = `${scrollRect.top}px`;
    overlay.style.width = `${tableRect.width}px`;
    overlay.style.height = `${rowRect.height}px`;
    const clipLeft = Math.max(0, scrollRect.left - tableRect.left);
    const clipRight = Math.max(0, tableRect.right - scrollRect.right);
    // clip-path trims the overlay to the editor viewport; keep overflow visible so
    // the table's outer right border is not clipped by 1px at the edge.
    overlay.style.clipPath = clipLeft > 0 || clipRight > 0
      ? `inset(0px ${clipRight}px 0px ${clipLeft}px)`
      : 'none';
  }

  private removeStickyHeader(): void {
    if (this.stickyHeaderFrame !== null) {
      cancelAnimationFrame(this.stickyHeaderFrame);
      this.stickyHeaderFrame = null;
    }
    this.stickyHeaderObserver?.disconnect();
    this.stickyHeaderObserver = null;
    this.stickyHeaderOverlay?.remove();
    this.stickyHeaderOverlay = null;
  }

  /**
   * Create and position control elements (grips and add buttons)
   */
  private updateControls(node: ProsemirrorNode): void {
    if (!this.controlsContainer || !this.columnControlsContainer || !this.scrollable || !this.table || !getEditorView())
      return;

    // Check if we have a toolbar request from grip click, otherwise save current state
    let toolbarToShow: {
      type: 'row' | 'column' | 'table';
      index: number;
    } | null = null;

    if (this.toolbarRequest) {
      // Use toolbar request from grip click (priority)
      toolbarToShow = this.toolbarRequest;
      // DON'T clear yet - will be cleared after successful show in requestAnimationFrame
    } else if (this.gripToolbar) {
      // Save current toolbar state for general updates (resize, etc)
      const state = this.gripToolbar.getState();
      if (state) {
        toolbarToShow = state;
      }
    }

    // Clear existing controls
    this.controlsContainer.innerHTML = '';
    this.columnControlsContainer.innerHTML = '';

    if (!node || !node.type || node.type.name !== 'table') {
      return;
    }

    const view = getEditorView();
    if (!view) return;
    const selectedRows = new Set<number>();
    const selectedColumns = new Set<number>();
    let showTableGrip = false;

    try {
      const activeRect = tableCommands.selectedRect(view.state);
      const activeTableDom = view.nodeDOM(activeRect.tableStart - 1) as HTMLElement | null;
      const activeWrapper = activeTableDom?.closest('.table-wrapper');
      const isActiveTable = activeWrapper === this.dom;

      if (isActiveTable) {
        if (isTableSelected(view.state)) {
          showTableGrip = true;
        } else {
          for (let row = activeRect.top; row < activeRect.bottom; row++) {
            selectedRows.add(row);
          }
          for (let col = activeRect.left; col < activeRect.right; col++) {
            selectedColumns.add(col);
          }

          if (selectedRows.size === 0 && !isColumnSelection(view.state.selection)) {
            selectedRows.add(activeRect.top);
          }
          if (selectedColumns.size === 0 && !isRowSelection(view.state.selection)) {
            selectedColumns.add(activeRect.left);
          }
        }
      }
    } catch {
      // Ignore non-table selections; controls stay hidden until a table selection exists.
    }

    const map = TableMap.get(node);
    const rows = this.getDirectRows();
    const firstRow = rows[0];

    if (!firstRow) return;

    const tableRect = this.table.getBoundingClientRect();
    const { tableTopOffset, tableLeftOffset } = this.getRowControlTableOffsets();
    this.applyRowControlContainerBox(tableTopOffset, tableLeftOffset, tableRect.height);

    // Column grips and add buttons (inside scrollable)
    const columnSegments = this.getRenderedColumnSegments(node, map, tableRect);
    this.applyColumnControlContainerBox(tableTopOffset);

    columnSegments.forEach((segment, colIndex) => {
      const left = segment.left;
      const right = segment.right;

      // Column grip (with gap for table border)
      const colGrip = document.createElement('div');
      colGrip.className = TableStyleHelper.tableGripColumn;
      colGrip.dataset.index = String(colIndex);
      colGrip.style.position = 'absolute';
      colGrip.style.left = `${left + 0.5}px`;
      colGrip.style.top = `${this.columnGripInsetTop}px`;
      colGrip.style.width = `${Math.max(0, right - left - 1)}px`;
      colGrip.style.height = `${this.columnGripHeight}px`;
      if (colIndex === 0) {
        colGrip.classList.add(TableStyleHelper.first);
        colGrip.style.left = `${left}px`;
        colGrip.style.width = `${Math.max(0, right - left - 0.5)}px`;
      }
      if (colIndex === columnSegments.length - 1) {
        colGrip.classList.add(TableStyleHelper.last);
        colGrip.style.width = `${Math.max(0, right - left - 0.5)}px`;
      }
      if (selectedColumns.has(colIndex)) {
        colGrip.classList.add(TableStyleHelper.selected);
      }
      colGrip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const view = getEditorView();
        if (!view) return;

        // Selection-only transactions retain this table node. Keep the existing
        // grip DOM intact (avoids reflowing nested scrollports) and show the
        // toolbar from this same grip instead of waiting for updateControls().
        this.toolbarRequest = { type: 'column', index: colIndex };
        tableCommands.selectColumn(colIndex)(view.state, (tr) => {
          tr.setMeta('gripSelection', true);
          view.dispatch(tr);
        });
        this.showToolbarForGrip('column', colIndex, colGrip);
      });
      this.columnControlsContainer!.appendChild(colGrip);

      // Add column button (after each column)
      const addCol = document.createElement('div');
      addCol.className = TableStyleHelper.tableAddColumn;
      addCol.dataset.index = String(colIndex + 1);
      addCol.style.position = 'absolute';
      addCol.style.left = `${right - 10}px`;
      addCol.style.top = '0px'; // Keep add handle anchored in the top control band
      addCol.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const view = getEditorView();
        if (view) {
          const targetIndex = colIndex + 1;
          tableCommands.addColumnBefore({ index: targetIndex })(view.state, view.dispatch);
        }
      });
      this.columnControlsContainer!.appendChild(addCol);

      // Add column button before first column
      if (colIndex === 0) {
        const addColBefore = document.createElement('div');
        addColBefore.className = TableStyleHelper.tableAddColumn;
        addColBefore.dataset.index = '0';
        addColBefore.style.position = 'absolute';
        addColBefore.style.left = `${left - 10}px`;
        addColBefore.style.top = '0px'; // Keep add handle anchored in the top control band
        addColBefore.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (getEditorView()) {
            tableCommands.addColumnBefore({ index: 0 })(getEditorView().state, getEditorView().dispatch);
          }
        });
        this.columnControlsContainer!.appendChild(addColBefore);
      }
    });

    // Row grips and add buttons
    const rowGripLeft = tableLeftOffset - 16; // Align to the actual rendered table, not the wrapper padding.

    rows.forEach((row, rowIndex) => {
      const firstCell = row.querySelector(':scope > td, :scope > th');
      if (!firstCell) return;

      const { top: rowTop, bottom: rowBottom } = this.getBoundedRowGeometry(row, tableRect);
      const rowHeight = Math.max(0, rowBottom - rowTop);

      // Check if this row is a header (contains th elements)
      const isHeaderRow = row.querySelector(':scope > th') !== null;

      // Row grip (with gap for table border)
      const rowGrip = document.createElement('div');
      rowGrip.className = TableStyleHelper.tableGripRow;
      if (isHeaderRow) {
        rowGrip.classList.add('header');
      }
      rowGrip.dataset.index = String(rowIndex);
      rowGrip.style.position = 'absolute';
      rowGrip.style.left = `${rowGripLeft}px`;
      rowGrip.style.top = `${rowTop + 0.5}px`;
      rowGrip.style.width = '12px';
      rowGrip.style.height = `${Math.max(0, rowHeight - 1)}px`;
      if (rowIndex === 0) {
        rowGrip.classList.add(TableStyleHelper.first);
        rowGrip.style.top = `${rowTop}px`;
        rowGrip.style.height = `${Math.max(0, rowHeight - 0.5)}px`;
      }
      if (rowIndex === rows.length - 1) {
        rowGrip.classList.add(TableStyleHelper.last);
        rowGrip.style.height = `${Math.max(0, rowHeight - 0.5)}px`;
      }
      if (selectedRows.has(rowIndex)) {
        rowGrip.classList.add(TableStyleHelper.selected);
      }
      rowGrip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const view = getEditorView();
        if (!view) return;

        // See the column-grip handler: selection-only updates deliberately do
        // not rebuild this table's controls, so open the toolbar from the
        // existing row grip after the selection transaction has been applied.
        this.toolbarRequest = { type: 'row', index: rowIndex };
        tableCommands.selectRow(rowIndex, e.shiftKey)(view.state, (tr) => {
          tr.setMeta('gripSelection', true);
          view.dispatch(tr);
        });
        this.showToolbarForGrip('row', rowIndex, rowGrip);
      });

      this.controlsContainer!.appendChild(rowGrip);

      // Add row button (after each row)
      const addRow = document.createElement('div');
      addRow.className = TableStyleHelper.tableAddRow;
      addRow.dataset.index = String(rowIndex + 1);
      addRow.style.position = 'absolute';
      addRow.style.left = `${tableLeftOffset - 32}px`;
      addRow.style.top = `${rowBottom - 10}px`;
      addRow.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const view = getEditorView();
        if (view) {
          tableCommands.addRowBefore({ index: rowIndex + 1 })(view.state, view.dispatch);
        }
      });
      this.controlsContainer!.appendChild(addRow);

      // Add row button before first row
      if (rowIndex === 0) {
        const addRowBefore = document.createElement('div');
        addRowBefore.className = TableStyleHelper.tableAddRow;
        addRowBefore.dataset.index = '0';
        addRowBefore.style.position = 'absolute';
        addRowBefore.style.left = `${tableLeftOffset - 32}px`;
        addRowBefore.style.top = `${rowTop - 10}px`;
        addRowBefore.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (getEditorView()) {
            tableCommands.addRowBefore({ index: 0 })(getEditorView().state, getEditorView().dispatch);
          }
        });
        this.controlsContainer!.appendChild(addRowBefore);
      }
    });

    // Table grip (corner)
    const tableGrip = document.createElement('div');
    tableGrip.className = TableStyleHelper.tableGrip;
    if (showTableGrip) {
      tableGrip.classList.add(TableStyleHelper.selected);
    }
    tableGrip.style.position = 'absolute';
    tableGrip.style.left = `${this.getTableGripLeft(tableLeftOffset)}px`;
    tableGrip.style.top = this.getTableGripTop();
    tableGrip.style.width = `${this.tableGripSize}px`;
    tableGrip.style.height = `${this.tableGripSize}px`;
    tableGrip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const view = getEditorView();
      if (!view) return;

      // Show inline toolbar for table
      if (this.gripToolbar) {
        this.gripToolbar.showForTable(tableGrip);
      }
    });
    this.controlsContainer!.appendChild(tableGrip);

    // Show toolbar immediately after grips are created
    if (toolbarToShow && this.gripToolbar) {
      // Use requestAnimationFrame to ensure grips are in DOM
      requestAnimationFrame(() => {
        if (!this.gripToolbar || !toolbarToShow) return;

        if (toolbarToShow.type === 'row') {
          const rowGrip = this.controlsContainer!.querySelector(
            `.${TableStyleHelper.tableGripRow}[data-index="${toolbarToShow.index}"]`
          ) as HTMLElement;
          if (rowGrip) {
            this.gripToolbar.showForRow(rowGrip, toolbarToShow.index);
            this.toolbarRequest = null; // Clear request after successful show
          }
        } else if (toolbarToShow.type === 'column') {
          const colGrip = this.columnControlsContainer!.querySelector(
            `.${TableStyleHelper.tableGripColumn}[data-index="${toolbarToShow.index}"]`
          ) as HTMLElement;
          if (colGrip) {
            this.gripToolbar.showForColumn(colGrip, toolbarToShow.index);
            this.toolbarRequest = null; // Clear request after successful show
          }
        } else if (toolbarToShow.type === 'table') {
          // Table grip doesn't have index, just find the table grip element
          const tableGripElement = this.controlsContainer!.querySelector(
            `.${TableStyleHelper.tableGrip}`
          ) as HTMLElement;
          if (tableGripElement) {
            this.gripToolbar.showForTable(tableGripElement);
          }
        }
      });
    }
  }

  /**
   * Show a row/column toolbar after a selection-only transaction. Such a
   * transaction keeps the ProseMirror table node identical, and update() is
   * intentionally a no-op to avoid rewriting nested-table column widths.
   */
  private showToolbarForGrip(type: 'row' | 'column', index: number, grip: HTMLElement): void {
    requestAnimationFrame(() => {
      if (!this.gripToolbar || !this.dom.isConnected || !grip.isConnected) return;

      this.refreshControlSelection();
      if (type === 'row') {
        this.gripToolbar.showForRow(grip, index);
      } else {
        this.gripToolbar.showForColumn(grip, index);
      }
      this.toolbarRequest = null;
    });
  }

  /** Update only selection classes; do not create, remove, or remeasure grips. */
  private refreshControlSelection(): void {
    if (!this.controlsContainer || !this.columnControlsContainer || !this.dom) return;

    const selectedRows = new Set<number>();
    const selectedColumns = new Set<number>();
    let showTableGrip = false;
    const view = getEditorView();
    if (!view) return;

    try {
      const activeRect = tableCommands.selectedRect(view.state);
      const activeTableDom = view.nodeDOM(activeRect.tableStart - 1) as HTMLElement | null;
      const isActiveTable = activeTableDom?.closest('.table-wrapper') === this.dom;
      if (isActiveTable) {
        if (isTableSelected(view.state)) {
          showTableGrip = true;
        } else {
          for (let row = activeRect.top; row < activeRect.bottom; row++) selectedRows.add(row);
          for (let col = activeRect.left; col < activeRect.right; col++) selectedColumns.add(col);
          if (selectedRows.size === 0 && !isColumnSelection(view.state.selection)) selectedRows.add(activeRect.top);
          if (selectedColumns.size === 0 && !isRowSelection(view.state.selection)) selectedColumns.add(activeRect.left);
        }
      }
    } catch {
      // A text selection outside a table simply clears the previous control state.
    }

    this.controlsContainer.querySelectorAll<HTMLElement>(`.${TableStyleHelper.tableGripRow}`).forEach((grip) => {
      grip.classList.toggle(TableStyleHelper.selected, selectedRows.has(Number(grip.dataset.index)));
    });
    this.columnControlsContainer.querySelectorAll<HTMLElement>(`.${TableStyleHelper.tableGripColumn}`).forEach((grip) => {
      grip.classList.toggle(TableStyleHelper.selected, selectedColumns.has(Number(grip.dataset.index)));
    });
    this.controlsContainer
      .querySelector(`.${TableStyleHelper.tableGrip}`)
      ?.classList.toggle(TableStyleHelper.selected, showTableGrip);
  }

  /**
   * Refresh both control bands in place when their DOM still represents the
   * current table. Rebuild only after an actual row/column structure change.
   */
  private refreshControlGeometryOrRebuild(node: ProsemirrorNode): void {
    if (!this.controlsContainer || !this.columnControlsContainer || !this.table || !this.scrollable) return;
    const map = TableMap.get(node);
    const rows = this.getDirectRows();
    const rowGripCount = this.controlsContainer.querySelectorAll(`.${TableStyleHelper.tableGripRow}`).length;
    const rowAddCount = this.controlsContainer.querySelectorAll(`.${TableStyleHelper.tableAddRow}`).length;
    const columnGripCount = this.columnControlsContainer.querySelectorAll(`.${TableStyleHelper.tableGripColumn}`).length;
    const columnAddCount = this.columnControlsContainer.querySelectorAll(`.${TableStyleHelper.tableAddColumn}`).length;
    const hasTableGrip = Boolean(this.controlsContainer.querySelector(`.${TableStyleHelper.tableGrip}`));

    if (
      rowGripCount !== rows.length ||
      rowAddCount !== rows.length + 1 ||
      columnGripCount !== map.width ||
      columnAddCount !== map.width + 1 ||
      !hasTableGrip
    ) {
      this.updateControls(node);
      return;
    }

    this.refreshRowControlGeometry(rows);
    this.refreshColumnControlGeometry(node);
  }

  /** Offsets relative to the scrollport so markers stay glued to the table. */
  private getRowControlTableOffsets(): { tableTopOffset: number; tableLeftOffset: number } {
    return {
      tableTopOffset: this.table.offsetTop,
      tableLeftOffset: this.table.offsetLeft,
    };
  }

  /** Anchor the column band just above the table instead of the scrollport top. */
  private getColumnControlsTop(tableTopOffset: number): number {
    const previousGap = Math.max(0, tableTopOffset - this.columnGripInsetTop - this.columnGripHeight);
    const gap = Math.max(1, previousGap / 2);
    return Math.max(0, tableTopOffset - gap - this.columnGripInsetTop - this.columnGripHeight);
  }

  private applyColumnControlContainerBox(tableTopOffset: number): void {
    if (!this.columnControlsContainer || !this.table) return;
    this.columnControlsContainer.style.left = `${this.table.offsetLeft}px`;
    this.columnControlsContainer.style.width = `${this.table.offsetWidth}px`;
    this.columnControlsContainer.style.top = `${this.getColumnControlsTop(tableTopOffset)}px`;
    this.columnControlsContainer.style.height = `${this.columnControlBandHeight}px`;
  }

  private applyRowControlContainerBox(tableTopOffset: number, tableLeftOffset: number, tableHeight: number): void {
    if (!this.controlsContainer || !this.table) return;
    this.controlsContainer.style.position = 'absolute';
    this.controlsContainer.style.left = '0px';
    this.controlsContainer.style.top = `${tableTopOffset}px`;
    this.controlsContainer.style.width = `${this.table.offsetLeft + this.table.offsetWidth}px`;
    this.controlsContainer.style.height = `${Math.max(0, tableHeight)}px`;
    this.controlsContainer.style.overflow = 'visible';
    this.controlsContainer.style.pointerEvents = 'none';
    this.controlsContainer.style.setProperty('--table-row-control-bg-left', `${tableLeftOffset - 20}px`);
  }

  /** Update row grips/buttons without destroying their listeners or DOM. */
  private refreshRowControlGeometry(rows = this.getDirectRows()): void {
    if (!this.controlsContainer || !this.table || !this.dom) return;
    const tableRect = this.table.getBoundingClientRect();
    const { tableTopOffset, tableLeftOffset } = this.getRowControlTableOffsets();
    const rowGripLeft = tableLeftOffset - 16;

    this.applyRowControlContainerBox(tableTopOffset, tableLeftOffset, tableRect.height);

    rows.forEach((row, rowIndex) => {
      const { top, bottom } = this.getBoundedRowGeometry(row, tableRect);
      const height = Math.max(0, bottom - top);
      const grip = this.controlsContainer!.querySelector(
        `.${TableStyleHelper.tableGripRow}[data-index="${rowIndex}"]`
      ) as HTMLElement | null;
      if (grip) {
        const isFirst = rowIndex === 0;
        const isLast = rowIndex === rows.length - 1;
        grip.style.left = `${rowGripLeft}px`;
        grip.style.top = `${isFirst ? top : top + 0.5}px`;
        grip.style.height = `${Math.max(0, height - (isFirst || isLast ? 0.5 : 1))}px`;
      }

      const addAfter = this.controlsContainer!.querySelector(
        `.${TableStyleHelper.tableAddRow}[data-index="${rowIndex + 1}"]`
      ) as HTMLElement | null;
      if (addAfter) {
        addAfter.style.left = `${tableLeftOffset - 32}px`;
        addAfter.style.top = `${bottom - 10}px`;
      }
      if (rowIndex === 0) {
        const addBefore = this.controlsContainer!.querySelector(
          `.${TableStyleHelper.tableAddRow}[data-index="0"]`
        ) as HTMLElement | null;
        if (addBefore) {
          addBefore.style.left = `${tableLeftOffset - 32}px`;
          addBefore.style.top = `${top - 10}px`;
        }
      }
    });

    const tableGrip = this.controlsContainer.querySelector(`.${TableStyleHelper.tableGrip}`) as HTMLElement | null;
    if (tableGrip) {
      tableGrip.style.left = `${this.getTableGripLeft(tableLeftOffset)}px`;
      tableGrip.style.top = this.getTableGripTop();
      tableGrip.style.width = `${this.tableGripSize}px`;
      tableGrip.style.height = `${this.tableGripSize}px`;
    }
  }

  /**
   * Sit the corner dot in the open square of the L formed by the row and
   * column bars — not on the table corner, and not on either dashed bar.
   * The scrollport keeps a left/top gutter so this offset stays visible at
   * scroll origin and travels with the table when it scrolls horizontally.
   */
  private getTableGripLeft(tableLeftOffset: number): number {
    return tableLeftOffset - this.tableGripLeftOffset;
  }

  private getTableGripTop(): string {
    return `${-this.tableGripTopOffset}px`;
  }

  /** Never let a delayed layout measurement render a row marker outside its table. */
  private getBoundedRowGeometry(row: HTMLTableRowElement, tableRect: DOMRect): { top: number; bottom: number } {
    const rowRect = row.getBoundingClientRect();
    const top = Math.max(0, Math.min(tableRect.height, rowRect.top - tableRect.top));
    const bottom = Math.max(top, Math.min(tableRect.height, rowRect.bottom - tableRect.top));
    return { top, bottom };
  }

  /**
   * Keep already-rendered column controls aligned after a column resize without
   * replacing their DOM nodes. Rebuilding controls here creates dozens of
   * child-list mutations and repaints the full VS Code webview.
   */
  private refreshColumnControlGeometry(node: ProsemirrorNode): void {
    if (!this.columnControlsContainer || !this.scrollable || !this.table || node.type.name !== 'table') return;

    const map = TableMap.get(node);
    const segments = this.getRenderedColumnSegments(node, map, this.table.getBoundingClientRect());
    if (!segments.length) return;

    this.applyColumnControlContainerBox(this.table.offsetTop);

    for (const [index, segment] of segments.entries()) {
      const grip = this.columnControlsContainer.querySelector(
        `.${TableStyleHelper.tableGripColumn}[data-index="${index}"]`
      ) as HTMLElement | null;
      if (grip) {
        const isFirst = index === 0;
        const isLast = index === segments.length - 1;
        grip.style.left = `${isFirst ? segment.left : segment.left + 0.5}px`;
        grip.style.width = `${Math.max(0, segment.right - segment.left - (isFirst || isLast ? 0.5 : 1))}px`;
      }

      const addAfter = this.columnControlsContainer.querySelector(
        `.${TableStyleHelper.tableAddColumn}[data-index="${index + 1}"]`
      ) as HTMLElement | null;
      if (addAfter) addAfter.style.left = `${segment.right - 10}px`;
    }

    const addBefore = this.columnControlsContainer.querySelector(
      `.${TableStyleHelper.tableAddColumn}[data-index="0"]`
    ) as HTMLElement | null;
    if (addBefore) addBefore.style.left = `${segments[0].left - 10}px`;
  }

  private getDirectRows(): HTMLTableRowElement[] {
    // `HTMLTableSectionElement.rows` excludes nested tables. Keep the explicit
    // ownership check as a safeguard for malformed pasted HTML.
    return Array.from(this.table.tBodies)
      .flatMap((body) => Array.from(body.rows))
      .filter((row) => row.closest('table') === this.table);
  }

  private applyRowHeights(node: ProsemirrorNode): void {
    const rows = this.getDirectRows();
    const rowCount = Math.min(rows.length, node.childCount);

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
      const row = rows[rowIndex];
      const height = this.normalizeRowHeight(node.child(rowIndex).attrs.height);
      // A ResizeObserver delivery can happen repeatedly during a column-width
      // change. Do not rewrite every td/content viewport when this row already
      // has the requested height; a large nested table otherwise turns a
      // horizontal gesture into thousands of redundant style mutations.
      if (this.renderedRowHeightCache.has(row) && this.renderedRowHeightCache.get(row) === height) continue;
      this.applyRenderedRowHeight(row, height);
      this.renderedRowHeightCache.set(row, height);
    }
  }

  /**
   * Apply an explicit height to the real table row and turn every cell's
   * contentDOM into a fixed-height viewport. Only padding and borders count as
   * cell chrome. Using `offsetHeight - content.clientHeight` is incorrect for a
   * naturally tall row because that difference also contains all free vertical
   * space in short cells, which previously collapsed the viewport to 0px.
   */
  private applyRenderedRowHeight(row: HTMLTableRowElement, height: number | null): void {
    const cells = Array.from(row.cells);

    // Do not write preview attributes/styles to <tr>. Table rows use the
    // default ProseMirror DOM view, so a <tr> mutation can be reparsed and the
    // whole row replaced during the drag. Cells have TableCellView node views
    // whose ignoreMutation() explicitly protects these visual-only writes.
    cells.forEach((cell) => {
      const content = cell.querySelector(':scope > .easyview-table-cell-content') as HTMLDivElement | null;
      if (height === null) {
        cell.removeAttribute('data-easyview-row-resized');
        cell.style.height = '';
        cell.style.boxSizing = '';
        if (content) {
          content.style.height = '';
          content.style.maxHeight = '';
        }
        syncTableCellVerticalAlignmentLayout(cell, content);
        return;
      }

      cell.setAttribute('data-easyview-row-resized', 'true');
      cell.style.boxSizing = 'border-box';
      cell.style.height = `${height}px`;
      if (!content) return;

      const style = getComputedStyle(cell);
      const verticalChrome =
        this.cssPixels(style.paddingTop) +
        this.cssPixels(style.paddingBottom) +
        this.cssPixels(style.borderTopWidth) +
        this.cssPixels(style.borderBottomWidth);
      const contentHeight = Math.max(1, height - verticalChrome);
      content.style.height = `${contentHeight}px`;
      content.style.maxHeight = `${contentHeight}px`;
      syncTableCellVerticalAlignmentLayout(cell, content);
    });
  }

  private cssPixels(value: string): number {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private logRowResize(stage: string, data: Record<string, unknown>): void {
    if (!(window as Window & { __EASYVIEW_ROW_RESIZE_DEBUG?: boolean }).__EASYVIEW_ROW_RESIZE_DEBUG) {
      return;
    }
    const message = {
      type: 'rowResizeDebug',
      stage,
      data,
    };
    console.info('[EasyView RowResize]', message);
    try {
      (window as any).__vscodeApi?.postMessage(message);
    } catch {
      // Diagnostics must never interrupt normal table editing.
    }
  }

  private isEventFromNestedTable(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const nested = target.closest('.table-wrapper');
    return Boolean(nested && nested !== this.dom);
  }

  private isNearColumnDivider(event: PointerEvent): boolean {
    if (!(event.target instanceof HTMLElement)) return false;
    const cell = event.target.closest('td, th') as HTMLTableCellElement | null;
    if (!cell || cell.closest('.table-wrapper') !== this.dom) return false;
    const rect = cell.getBoundingClientRect();
    return event.clientX >= rect.right - 8 && event.clientX <= rect.right + 4;
  }

  private shouldLockHorizontalScroll(): boolean {
    return this.isColumnResizing() && this.isColumnResizeInteractionOnThisTable();
  }

  private isOnHorizontalScrollbar(event: MouseEvent): boolean {
    if (!this.scrollable) return false;
    const rect = this.scrollable.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right) return false;
    const classicBar = this.scrollable.offsetHeight - this.scrollable.clientHeight;
    const bar = classicBar > 0 ? classicBar : 14;
    return (
      this.scrollable.scrollWidth > this.scrollable.clientWidth + 1 &&
      event.clientY >= rect.bottom - bar &&
      event.clientY <= rect.bottom + 2
    );
  }

  private isColumnResizeDragging(): boolean {
    const view = getEditorView();
    if (!view) return false;
    return Boolean(columnResizingPluginKey.getState(view.state)?.dragging);
  }

  private shouldDeferColumnResizeLayout(): boolean {
    // `activeHandle` is editor-global. During nested-table hover, ProseMirror
    // can schedule ResizeObserver/layout work for an ancestor TableView even
    // though that ancestor does not own the handle. Any width write there can
    // shrink the nested scrollport and clamp its scrollLeft to zero.
    return (
      this.columnResizeSession ||
      this.columnResizeCommitPending ||
      this.hasActiveColumnResizeHandle()
    );
  }

  private rememberStableHorizontalScroll(): void {
    if (!this.scrollable) return;

    if (!this.shouldLockHorizontalScroll()) {
      const left = this.scrollable.scrollLeft;
      // A decoration/control rebuild can collapse scrollLeft to 0 in the same
      // turn as pointerdown. Do not learn that collapsed value.
      if (!(this.stableScrollLeft > 1 && left < 1)) {
        this.stableScrollLeft = left;
        this.rememberAncestorScrollSnapshots();
      }
    }

    this.pinnedHorizontalScroll = this.captureHorizontalScrollSnapshots().map((snapshot) => {
      if (snapshot.el === this.scrollable) {
        return { el: snapshot.el, left: this.stableScrollLeft };
      }
      const locked = this.stableAncestorScrolls.get(snapshot.el);
      return locked == null ? snapshot : { el: snapshot.el, left: locked };
    });
  }

  private rememberAncestorScrollSnapshots(): void {
    this.stableAncestorScrolls.clear();
    for (const snapshot of this.captureHorizontalScrollSnapshots()) {
      if (snapshot.el === this.scrollable) continue;
      this.stableAncestorScrolls.set(snapshot.el, snapshot.left);
    }
  }

  private clampScrollLeft(left: number): number {
    if (!this.scrollable) return left;
    const max = Math.max(0, this.scrollable.scrollWidth - this.scrollable.clientWidth);
    return Math.min(Math.max(0, left), max);
  }

  private restoreColumnResizeScroll(): void {
    if (!this.scrollable) return;
    const left = this.clampScrollLeft(this.stableScrollLeft);
    if (Math.abs(this.scrollable.scrollLeft - left) <= 0.5) return;
    this.ignoringScrollEvent = true;
    this.scrollable.scrollLeft = left;
    this.ignoringScrollEvent = false;
  }

  private restoreStableHorizontalScroll(): void {
    if (!this.scrollable) return;

    const max = Math.max(0, this.scrollable.scrollWidth - this.scrollable.clientWidth);
    const applied = Math.min(this.stableScrollLeft, max);
    if (Math.abs(this.scrollable.scrollLeft - applied) > 0.5) {
      this.ignoringScrollEvent = true;
      this.scrollable.scrollLeft = applied;
      this.ignoringScrollEvent = false;
    }

    for (const [el, left] of this.stableAncestorScrolls) {
      if (el.isConnected && Math.abs(el.scrollLeft - left) > 0.5) {
        el.scrollLeft = left;
      }
    }
    this.restoreHorizontalScrollSnapshots(this.pinnedHorizontalScroll);
  }

  private isColumnResizeInteractionOnThisTable(): boolean {
    const view = getEditorView();
    if (!view) return false;
    const pluginState = columnResizingPluginKey.getState(view.state);
    if (!pluginState || pluginState.activeHandle < 0) return false;

    try {
      const cellDom = view.nodeDOM(pluginState.activeHandle);
      const cellEl =
        cellDom instanceof HTMLElement
          ? cellDom
          : cellDom && 'parentElement' in cellDom
            ? (cellDom as Node).parentElement
            : null;
      // `contains()` also matches a cell from a nested table. That makes every
      // ancestor table run resize-time scroll restoration, which can reset the
      // nested viewport while the user is dragging. Only the cell's closest
      // table wrapper owns this resize interaction.
      return cellEl?.closest('.table-wrapper') === this.dom;
    } catch {
      return false;
    }
  }

  /**
   * Resolve the cell on the left side of a column divider. The first branch
   * uses prosemirror-tables' hover state; the DOM fallback specifically covers
   * the small event-order gap between a second mouseup and its dblclick event.
   */
  private getColumnResizeCellAtEvent(view: EditorView, event: MouseEvent): number {
    const pluginState = columnResizingPluginKey.getState(view.state);
    if (pluginState?.activeHandle >= 0 && this.isColumnResizeInteractionOnThisTable()) {
      return pluginState.activeHandle;
    }

    if (!(event.target instanceof HTMLElement)) return -1;
    const domCell = event.target.closest('td, th') as HTMLTableCellElement | null;
    if (!domCell || domCell.closest('.table-wrapper') !== this.dom) return -1;

    const rect = domCell.getBoundingClientRect();
    const handleWidth = 8;
    const nearRight = rect.right - event.clientX <= handleWidth;
    const nearLeft = event.clientX - rect.left <= handleWidth;
    if (!nearRight && !nearLeft) return -1;

    try {
      const position = view.posAtDOM(domCell, 0);
      const $pos = view.state.doc.resolve(position);
      let cellDepth = -1;
      for (let depth = $pos.depth; depth > 0; depth--) {
        const role = $pos.node(depth).type.spec.tableRole;
        if (role === 'cell' || role === 'header_cell') {
          cellDepth = depth;
          break;
        }
      }
      if (cellDepth < 0) return -1;
      const currentCellPos = $pos.before(cellDepth);
      if (nearRight) return currentCellPos;

      const $cell = view.state.doc.resolve(currentCellPos);
      const table = $cell.node(-1);
      const map = TableMap.get(table);
      const start = $cell.start(-1);
      const mapIndex = map.map.indexOf(currentCellPos - start);
      if (mapIndex < 0 || mapIndex % map.width === 0) return -1;
      return start + map.map[mapIndex - 1];
    } catch {
      return -1;
    }
  }

  /**
   * Equivalent to prosemirror-tables' internal `updateColumnWidth`, kept here
   * because that helper is not exported. A logical column may be represented
   * by multiple cells (rowspan/colspan), all of which must receive the same
   * persisted width.
   */
  private setColumnWidth(view: EditorView, cellPos: number, width: number): void {
    const $cell = view.state.doc.resolve(cellPos);
    const table = $cell.node(-1);
    const cell = $cell.nodeAfter;
    if (!table || table.type.name !== 'table' || !cell) return;

    const map = TableMap.get(table);
    const start = $cell.start(-1);
    const column = map.colCount($cell.pos - start) + cell.attrs.colspan - 1;
    const tr = view.state.tr;

    for (let row = 0; row < map.height; row++) {
      const mapIndex = row * map.width + column;
      if (row > 0 && map.map[mapIndex] === map.map[mapIndex - map.width]) continue;

      const pos = map.map[mapIndex];
      const targetCell = table.nodeAt(pos);
      if (!targetCell) continue;
      const attrs = targetCell.attrs;
      const widthIndex = attrs.colspan === 1 ? 0 : column - map.colCount(pos);
      if (attrs.colwidth?.[widthIndex] === width) continue;

      const colwidth = attrs.colwidth ? attrs.colwidth.slice() : Array(attrs.colspan).fill(0);
      colwidth[widthIndex] = width;
      tr.setNodeMarkup(start + pos, null, { ...attrs, colwidth });
    }

    // Clear the hover handle in the same transaction. Apart from preventing a
    // stale resize cursor, this guarantees that the following layout pass is
    // allowed to synchronize the compact width rather than being deferred.
    tr.setMeta(columnResizingPluginKey, { setHandle: -1 });
    if (tr.docChanged) view.dispatch(tr);
    else view.dispatch(tr);
  }

  private withPreservedHorizontalScroll(run: () => void): void {
    this.rememberStableHorizontalScroll();
    const snapshots = this.captureHorizontalScrollSnapshots().map((snapshot) => {
      if (snapshot.el === this.scrollable) {
        return { el: snapshot.el, left: this.stableScrollLeft };
      }
      const locked = this.stableAncestorScrolls.get(snapshot.el);
      return locked == null ? snapshot : { el: snapshot.el, left: locked };
    });
    run();
    this.restoreHorizontalScrollSnapshots(snapshots);
    this.restoreStableHorizontalScroll();
    requestAnimationFrame(() => {
      this.restoreHorizontalScrollSnapshots(snapshots);
      this.restoreStableHorizontalScroll();
    });
  }

  private captureHorizontalScrollSnapshots(): Array<{ el: HTMLElement; left: number }> {
    const snapshots: Array<{ el: HTMLElement; left: number }> = [];
    const seen = new Set<HTMLElement>();
    const track = (el: HTMLElement | null | undefined) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      snapshots.push({ el, left: el.scrollLeft });
    };

    // Nested / wide tables scroll inside their own wrapper.
    track(this.scrollable);

    // Parent cell viewport when this table is embedded in another table cell.
    let current: HTMLElement | null = this.dom?.parentElement ?? null;
    while (current) {
      if (
        current.classList.contains('easyview-table-cell-content') ||
        current.classList.contains('table-scrollable')
      ) {
        track(current);
      }
      current = current.parentElement;
    }

    return snapshots;
  }

  private restoreHorizontalScrollSnapshots(
    snapshots: Array<{ el: HTMLElement; left: number }> | null
  ): void {
    if (!snapshots) return;
    for (const { el, left } of snapshots) {
      if (el.isConnected && Math.abs(el.scrollLeft - left) > 0.5) {
        if (el === this.scrollable) this.ignoringScrollEvent = true;
        el.scrollLeft = left;
        if (el === this.scrollable) this.ignoringScrollEvent = false;
      }
    }
  }

  private isTableControlTarget(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      Boolean(target.closest('.table-controls, .table-column-controls'))
    );
  }

  private describeTarget(target: EventTarget | null): string {
    if (!(target instanceof HTMLElement)) return String(target);
    return `${target.tagName.toLowerCase()}${target.className ? `.${String(target.className).replace(/\s+/g, '.')}` : ''}`;
  }

  private getRowGeometry(): Array<Record<string, unknown>> {
    return this.getDirectRows().map((row, index) => {
      const rect = row.getBoundingClientRect();
      const firstCell = row.cells[0];
      const content = firstCell?.querySelector(':scope > .easyview-table-cell-content') as HTMLDivElement | null;
      return {
        index,
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        rowStyleHeight: row.style.height || null,
        cellHeight: firstCell ? Math.round(firstCell.getBoundingClientRect().height) : null,
        cellStyleHeight: firstCell?.style.height || null,
        contentClientHeight: content?.clientHeight ?? null,
        contentScrollHeight: content?.scrollHeight ?? null,
        contentStyleHeight: content?.style.height || null,
      };
    });
  }

  private getRowIndexAtHorizontalBorder(clientY: number): number | null {
    const hitSlop = 6;
    const rows = this.getDirectRows();
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const bottom = rows[rowIndex].getBoundingClientRect().bottom;
      if (Math.abs(clientY - bottom) <= hitSlop) return rowIndex;
    }
    return null;
  }

  private normalizeRowHeight(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    return Math.max(this.minRowHeight, Math.min(this.maxRowHeight, Math.round(value)));
  }

  private startRowResize(event: PointerEvent, rowIndex: number, renderedHeight: number): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0 || !getEditorView()) return;

    // A mouseup can be lost when the pointer leaves the webview. End any stale
    // session first so one interrupted drag never disables later drags.
    this.rowResizeCleanup?.();

    const startY = event.clientY;
    const pointerId = event.pointerId;
    const captureTarget = this.dom;
    try {
      captureTarget.setPointerCapture(pointerId);
    } catch {
      // Browsers can reject capture for a detached DOM node; window fallback
      // below remains available in that case.
    }
    const startHeight = this.normalizeRowHeight(renderedHeight) ?? this.minRowHeight;
    const editor = this.dom.closest('.ProseMirror') as HTMLElement | null;
    let latestHeight = startHeight;
    let finished = false;
    this.isRowResizing = true;
    this.logRowResize('start', {
      rowIndex,
      startY,
      renderedHeight,
      startHeight,
      rows: this.getRowGeometry(),
    });

    const applyPreview = (height: number) => {
      const row = this.getDirectRows()[rowIndex];
      if (!row) return;

      this.applyRenderedRowHeight(row, height);
      this.updateClassList(this.node);
      this.updateControls(this.node);
      this.logRowResize('preview', {
        rowIndex,
        requestedHeight: height,
        rows: this.getRowGeometry(),
      });
    };

    const stop = (commit: boolean) => {
      if (finished) return;
      finished = true;
      captureTarget.removeEventListener('pointermove', move, true);
      captureTarget.removeEventListener('pointerup', finish, true);
      captureTarget.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancel);
      if (captureTarget.hasPointerCapture(pointerId)) {
        captureTarget.releasePointerCapture(pointerId);
      }
      this.rowResizeCleanup = null;
      this.isRowResizing = false;
      editor?.classList.remove('row-resize-cursor');
      this.table.classList.remove('easyview-row-resize-ready');

      this.logRowResize('stop', {
        rowIndex,
        commit,
        latestHeight,
        rows: this.getRowGeometry(),
      });
      if (commit) this.commitRowHeight(rowIndex, latestHeight);
      else this.scheduleLayoutSync();
    };

    const move = (moveEvent: PointerEvent) => {
      if (!moveEvent.isPrimary) return;
      this.logRowResize('pointerMove', {
        rowIndex,
        clientY: moveEvent.clientY,
        target: this.describeTarget(moveEvent.target),
      });
      latestHeight = Math.max(
        this.minRowHeight,
        Math.min(this.maxRowHeight, Math.round(startHeight + moveEvent.clientY - startY))
      );
      applyPreview(latestHeight);
    };

    const finish = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId === pointerId) stop(true);
    };
    const cancel = () => stop(false);
    this.rowResizeCleanup = cancel;
    editor?.classList.add('row-resize-cursor');
    captureTarget.addEventListener('pointermove', move, true);
    captureTarget.addEventListener('pointerup', finish, true);
    captureTarget.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancel);
  }

  private commitRowHeight(rowIndex: number, height: number): void {
    const view = getEditorView();
    if (!view || !this.node) {
      this.logRowResize('commitSkipped', {
        rowIndex,
        height,
        hasView: Boolean(view),
        hasNode: Boolean(this.node),
      });
      return;
    }

    let tablePos: number | null = null;
    view.state.doc.descendants((node, pos) => {
      if (node === this.node) {
        tablePos = pos;
        return false;
      }
      return true;
    });
    if (tablePos === null) {
      this.logRowResize('commitSkipped', {
        rowIndex,
        height,
        reason: 'table-position-not-found',
      });
      return;
    }

    let rowPos = tablePos + 1;
    for (let index = 0; index < rowIndex; index++) {
      rowPos += this.node.child(index).nodeSize;
    }

    const row = this.node.child(rowIndex);
    if (!row || row.attrs.height === height) {
      this.logRowResize('commitSkipped', {
        rowIndex,
        height,
        rowExists: Boolean(row),
        existingHeight: row?.attrs.height ?? null,
      });
      this.scheduleLayoutSync();
      return;
    }

    this.logRowResize('commit', { rowIndex, height, tablePos, rowPos });
    view.dispatch(view.state.tr.setNodeMarkup(rowPos, undefined, { ...row.attrs, height }));
    this.scheduleLayoutSync();
  }

  private getRenderedColumnSegments(
    node: ProsemirrorNode,
    map: TableMap,
    tableRect: DOMRect
  ): Array<{ left: number; right: number }> {
    const edges: Array<number | null> = new Array(map.width + 1).fill(null);
    const rows = this.getDirectRows();
    let rowStart = 0;

    for (let rowIndex = 0; rowIndex < Math.min(node.childCount, rows.length); rowIndex++) {
      const rowNode = node.child(rowIndex);
      const cells = Array.from(rows[rowIndex].cells);
      let cellPos = rowStart + 1;

      for (let cellIndex = 0; cellIndex < Math.min(rowNode.childCount, cells.length); cellIndex++) {
        const cellNode = rowNode.child(cellIndex);
        const cellRect = cells[cellIndex].getBoundingClientRect();
        const mapped = map.findCell(cellPos);
        const span = Math.max(1, mapped.right - mapped.left);
        const left = cellRect.left - tableRect.left;
        const right = cellRect.right - tableRect.left;

        if (span === 1) {
          edges[mapped.left] ??= left;
          edges[mapped.right] ??= right;
        } else {
          const step = (right - left) / span;
          for (let col = mapped.left; col <= mapped.right; col++) {
            edges[col] ??= left + step * (col - mapped.left);
          }
        }

        cellPos += cellNode.nodeSize;
      }

      rowStart += rowNode.nodeSize;
    }

    edges[0] ??= 0;
    edges[map.width] ??= tableRect.width;
    for (let index = 1; index < edges.length - 1; index++) {
      if (edges[index] != null) continue;

      let leftIndex = index - 1;
      while (leftIndex >= 0 && edges[leftIndex] == null) leftIndex--;
      let rightIndex = index + 1;
      while (rightIndex < edges.length && edges[rightIndex] == null) rightIndex++;

      if (leftIndex >= 0 && rightIndex < edges.length && edges[leftIndex] != null && edges[rightIndex] != null) {
        const ratio = (index - leftIndex) / (rightIndex - leftIndex);
        edges[index] = edges[leftIndex]! + (edges[rightIndex]! - edges[leftIndex]!) * ratio;
      }
    }

    const fallbackWidth = tableRect.width / Math.max(1, map.width);
    return Array.from({ length: map.width }, (_, index) => {
      const left = edges[index] ?? fallbackWidth * index;
      const right = edges[index + 1] ?? fallbackWidth * (index + 1);
      return { left, right };
    });
  }

  override ignoreMutation(record: MutationRecord): boolean {
    // Row resizing is a visual preview until pointerup commits the row attr.
    // ProseMirror must not interpret these style/data changes as document edits
    // and rebuild the table halfway through the drag.
    if (
      record.type === 'attributes' &&
      (record.attributeName === 'style' || record.attributeName === 'data-easyview-row-resized') &&
      record.target instanceof HTMLElement &&
      record.target.matches('td, th, .easyview-table-cell-content')
    ) {
      return true;
    }

    // Ignore all mutations on the wrapper dom (class/style changes, drag handles, etc.)
    if (record.target === this.dom) {
      return true;
    }

    // Ignore changes to controls containers
    if (record.target === this.controlsContainer || this.controlsContainer?.contains(record.target as Node)) {
      return true;
    }

    if (
      record.target === this.columnControlsContainer ||
      this.columnControlsContainer?.contains(record.target as Node)
    ) {
      return true;
    }

    // Ignore changes to scrollable wrapper
    if (record.target === this.scrollable) {
      return true;
    }

    // Let parent handle table mutations (including resize)
    return super.ignoreMutation?.(record) ?? false;
  }

  /**
   * Update CSS classes and variables based on scroll position and dimensions
   */
  private updateClassList(node: ProsemirrorNode): void {
    if (!this.scrollable) return;

    // Do not overlay a left-edge scroll shadow. In a nested table it sits above
    // the scrolled content and makes part of the first column appear frozen.
    // The native scrollbar already indicates that more content exists.
    this.dom.classList.remove(TableStyleHelper.tableShadowLeft, TableStyleHelper.tableShadowRight);

    // Set CSS variables for table dimensions (used by hover line effects)
    // Use clientWidth/Height + grip width (12px) to reach the end
    this.dom.style.setProperty('--table-height', `${this.table.clientHeight + 12}px`);
    this.dom.style.setProperty('--table-width', `${this.table.clientWidth + 12}px`);
  }

  private isWrapMode(): boolean {
    return document.getElementById('editor')?.classList.contains('table-wrap') ?? false;
  }

  private isColumnResizing(): boolean {
    const view = getEditorView();
    return Boolean(view && columnResizingPluginKey.getState(view.state)?.dragging);
  }

  private hasActiveColumnResizeHandle(): boolean {
    const view = getEditorView();
    return Boolean(view && columnResizingPluginKey.getState(view.state)?.activeHandle >= 0);
  }

  private captureRenderedColumnWidths(): number[] | null {
    if (!this.node || !this.colgroup || !this.table) return null;

    const map = TableMap.get(this.node);
    if (map.width <= 0) return null;

    const widths = new Array<number>(map.width).fill(0);
    const columns = Array.from(this.colgroup.children) as HTMLTableColElement[];
    columns.forEach((column, index) => {
      if (index >= widths.length) return;
      const width = column.getBoundingClientRect().width;
      if (Number.isFinite(width) && width > 0) widths[index] = width;
    });

    // Chromium normally reports a box for <col>. Keep a cell-based fallback for
    // a detached/just-rebuilt colgroup and preserve colspan geometry.
    const firstRow = this.table.rows.item(0);
    if (firstRow) {
      let columnIndex = 0;
      for (const cell of Array.from(firstRow.cells)) {
        const colspan = Math.max(1, cell.colSpan || 1);
        const width = cell.getBoundingClientRect().width / colspan;
        if (Number.isFinite(width) && width > 0) {
          for (let offset = 0; offset < colspan && columnIndex + offset < widths.length; offset++) {
            if (widths[columnIndex + offset] <= 0) widths[columnIndex + offset] = width;
          }
        }
        columnIndex += colspan;
      }
    }

    return widths.some((width) => width > 0) ? widths : null;
  }

  private getPersistedColumnWidths(node: ProsemirrorNode): Array<number | null> {
    const map = TableMap.get(node);
    const widths = new Array<number | null>(map.width).fill(null);
    const row = node.firstChild;
    if (!row) return widths;

    let columnIndex = 0;
    for (let index = 0; index < row.childCount && columnIndex < widths.length; index++) {
      const cell = row.child(index);
      const colspan = Math.max(1, cell.attrs.colspan ?? 1);
      const colwidth = cell.attrs.colwidth;
      for (let offset = 0; offset < colspan && columnIndex < widths.length; offset++, columnIndex++) {
        const width = Array.isArray(colwidth) ? colwidth[offset] : null;
        widths[columnIndex] = typeof width === 'number' && width > 0 ? width : null;
      }
    }

    return widths;
  }

  private hasManualColumnWidths(node: ProsemirrorNode): boolean {
    const map = TableMap.get(node);
    const seen = new Set<number>();

    for (const pos of map.map) {
      if (seen.has(pos)) continue;
      seen.add(pos);

      const cell = node.nodeAt(pos);
      const colwidth = cell?.attrs?.colwidth;
      if (Array.isArray(colwidth) && colwidth.some((width) => typeof width === 'number' && width > 0)) {
        return true;
      }
    }

    return false;
  }

  private resetBalancedColumnWidths(): void {
    if (!this.node || !this.colgroup || !this.table) return;

    this.table.classList.remove(TableStyleHelper.tableBalancedWrap);
    this.table.classList.remove(TableStyleHelper.tableManualWidth);
    this.manualColumnWidthSnapshot = null;
    updateColumnsOnResize(this.node, this.colgroup, this.table, this.defaultCellMinWidth);
    this.table.style.width = '';
    this.table.style.minWidth = '';
  }

  private applyManualColumnWidths(): void {
    if (!this.node || !this.colgroup || !this.table) return;

    // Capture before updateColumnsOnResize() clears the inline width of columns
    // without an explicit `colwidth`. On the first resize this reads the
    // browser's intrinsic widths; on subsequent resizes the persistent snapshot
    // protects those columns even while the table uses table-layout: fixed.
    if (!this.manualColumnWidthSnapshot) {
      const renderedWidths = this.captureRenderedColumnWidths();
      if (renderedWidths) this.manualColumnWidthSnapshot = renderedWidths;
    }

    updateColumnsOnResize(this.node, this.colgroup, this.table, this.defaultCellMinWidth);

    const persistedWidths = this.getPersistedColumnWidths(this.node);
    const columns = Array.from(this.colgroup.children) as HTMLTableColElement[];
    const widths = persistedWidths.map((persistedWidth, index) => {
      const snapshotWidth = this.manualColumnWidthSnapshot?.[index] ?? 0;
      return persistedWidth ?? (snapshotWidth > 0 ? snapshotWidth : this.defaultCellMinWidth);
    });

    widths.forEach((width, index) => {
      const column = columns[index];
      if (column) column.style.width = `${Math.max(this.defaultCellMinWidth, Math.round(width))}px`;
    });
    this.manualColumnWidthSnapshot = widths;

    this.table.classList.remove(TableStyleHelper.tableBalancedWrap);
    this.table.classList.add(TableStyleHelper.tableManualWidth);
    const totalWidth = widths.reduce((total, width) => total + width, 0);
    this.table.style.width = `${Math.max(this.defaultCellMinWidth, Math.round(totalWidth))}px`;
    this.table.style.minWidth = '0';
  }

  private syncWrappedColumnWidths(): void {
    if (!this.node || !this.table || !this.colgroup || !this.scrollable || this.node.type.name !== 'table') return;

    if (this.hasManualColumnWidths(this.node)) {
      this.applyManualColumnWidths();
      return;
    }

    if (!this.isWrapMode()) {
      this.resetBalancedColumnWidths();
      return;
    }

    const map = TableMap.get(this.node);
    if (map.width <= 0) {
      this.resetBalancedColumnWidths();
      return;
    }

    const desiredWidths = new Array<number>(map.width).fill(40);
    const softMinWidths = new Array<number>(map.width).fill(40);
    const seen = new Set<number>();
    // querySelectorAll('tr') also returns rows from tables embedded in a cell.
    // Those rows do not map to this TableMap; measuring them here can write
    // nonsensical widths and continuously reflow the outer table.
    const tableRows = this.getDirectRows();

    for (let rowIndex = 0; rowIndex < map.height; rowIndex++) {
      const row = tableRows[rowIndex];
      if (!row) continue;
      const domCells = Array.from(row.children).filter(
        (cell): cell is HTMLTableCellElement => cell instanceof HTMLTableCellElement
      );
      let domCellIndex = 0;

      for (let colIndex = 0; colIndex < map.width; colIndex++) {
        const mapIndex = rowIndex * map.width + colIndex;
        const pos = map.map[mapIndex];
        if (seen.has(pos)) continue;
        seen.add(pos);

        const cell = this.node.nodeAt(pos);
        if (!cell) continue;

        const rect = map.findCell(pos);
        const colspan = Math.max(1, rect.right - rect.left);
        const domCell = domCells[domCellIndex] ?? null;
        domCellIndex += 1;

        const desiredWidth = this.measureCellDesiredWidth(cell, domCell);
        const softMinWidth = this.getColumnSoftMinWidth(cell, desiredWidth);
        const perColumnWidth = desiredWidth / colspan;
        const perColumnSoftMinWidth = softMinWidth / colspan;
        for (let col = rect.left; col < rect.right; col++) {
          desiredWidths[col] = Math.max(desiredWidths[col], perColumnWidth);
          softMinWidths[col] = Math.max(softMinWidths[col], perColumnSoftMinWidth);
        }
      }
    }

    const availableWidth = Math.max(240, this.scrollable.clientWidth - 40);
    const widths = this.allocateWrappedColumnPercents(desiredWidths, softMinWidths, availableWidth);

    const cols = Array.from(this.colgroup.children) as HTMLTableColElement[];
    widths.forEach((width, index) => {
      const col = cols[index];
      if (!col) return;
      col.style.width = `${width.toFixed(2)}%`;
    });

    this.table.style.width = '100%';
    this.table.style.minWidth = '';
    this.table.classList.remove(TableStyleHelper.tableManualWidth);
    this.table.classList.add(TableStyleHelper.tableBalancedWrap);
  }

  private measureCellDesiredWidth(cell: ProsemirrorNode, domCell: HTMLTableCellElement | null): number {
    const text = this.normalizeCellText(cell.textContent);
    const cellPadding = 28;
    const maxWidth = this.hasCodeContent(cell) ? 280 : 420;
    const compactBlankWidth = 36;

    if (!text) return compactBlankWidth;

    const measured = domCell ? this.measureTextWithCellFont(domCell, text) : this.estimateTextWidth(text);
    const longTokenWidth = this.estimateLongestTokenWidth(text, domCell);
    const contentWidth = Math.max(measured, longTokenWidth);

    return Math.max(compactBlankWidth, Math.min(maxWidth, contentWidth + cellPadding));
  }

  private getColumnSoftMinWidth(cell: ProsemirrorNode, desiredWidth: number): number {
    const defaultShortColumnMinWidth = cell.type.name === 'table_header' ? 86 : 68;
    const absoluteFloor = 36;
    return Math.max(absoluteFloor, Math.min(defaultShortColumnMinWidth, desiredWidth));
  }

  private hasCodeContent(node: ProsemirrorNode): boolean {
    let found = node.type.name === 'code_block';
    node.descendants((child) => {
      if (found) return false;
      if (child.type.name === 'code_block') {
        found = true;
        return false;
      }
      if (child.marks.some((mark) => mark.type.name === 'code')) {
        found = true;
        return false;
      }
      return true;
    });
    return found;
  }

  private normalizeCellText(text: string): string {
    return text
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private measureTextWithCellFont(cell: HTMLTableCellElement, text: string): number {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return this.estimateTextWidth(text);

    const style = window.getComputedStyle(cell);
    const fontStyle = style.fontStyle || 'normal';
    const fontVariant = style.fontVariant || 'normal';
    const fontWeight = style.fontWeight || '400';
    const fontSize = style.fontSize || '14px';
    const fontFamily = style.fontFamily || 'sans-serif';
    ctx.font = `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize} ${fontFamily}`;
    return Math.ceil(ctx.measureText(text).width);
  }

  private estimateTextWidth(text: string): number {
    const chineseChars = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
    const asciiChars = (text.match(/[A-Za-z0-9]/g) ?? []).length;
    const spaces = (text.match(/\s/g) ?? []).length;
    const punctuation = Math.max(0, text.length - chineseChars - asciiChars - spaces);
    return Math.ceil(chineseChars * 13.5 + asciiChars * 7.4 + punctuation * 6.4 + spaces * 4.2);
  }

  private estimateLongestTokenWidth(text: string, cell: HTMLTableCellElement | null): number {
    const tokens = text.split(/\s+/).filter(Boolean);
    if (!tokens.length) return 0;
    const longest = tokens.reduce((max, token) => (token.length > max.length ? token : max), '');
    if (!longest) return 0;
    const measured = cell ? this.measureTextWithCellFont(cell, longest) : this.estimateTextWidth(longest);
    return Math.min(240, measured + 12);
  }

  private allocateWrappedColumnPercents(
    desiredWidths: number[],
    softMinWidths: number[],
    availableWidth: number
  ): number[] {
    if (!desiredWidths.length) return [];

    const baseWidths = desiredWidths.map((width, index) => Math.max(softMinWidths[index] ?? 36, width));
    const totalBase = baseWidths.reduce((sum, width) => sum + width, 0);
    let finalWidths = [...baseWidths];

    if (totalBase < availableWidth) {
      const extra = availableWidth - totalBase;
      const flexWeights = baseWidths.map((width, index) => Math.max(0, width - (softMinWidths[index] ?? 36)) ** 1.15);
      const totalFlex = flexWeights.reduce((sum, width) => sum + width, 0);
      if (totalFlex > 0) {
        finalWidths = finalWidths.map((width, index) => width + (extra * flexWeights[index]) / totalFlex);
      } else {
        const shared = extra / finalWidths.length;
        finalWidths = finalWidths.map((width) => width + shared);
      }
    } else if (totalBase > availableWidth) {
      finalWidths = this.shrinkWidthsToFit(baseWidths, softMinWidths, availableWidth);
    }

    const total = finalWidths.reduce((sum, width) => sum + width, 0) || 1;
    return finalWidths.map((width) => (width / total) * 100);
  }

  private shrinkWidthsToFit(widths: number[], softMinWidths: number[], targetTotal: number): number[] {
    let result = [...widths];
    const floors = widths.map((width, index) => {
      const softMin = softMinWidths[index] ?? 36;
      return Math.max(36, Math.min(width, softMin));
    });
    let overflow = result.reduce((sum, width) => sum + width, 0) - targetTotal;

    while (overflow > 0.5) {
      const shrinkable = result
        .map((width, index) => ({ index, capacity: width - floors[index] }))
        .filter(({ capacity }) => capacity > 0.5);

      if (!shrinkable.length) break;

      const totalCapacity = shrinkable.reduce((sum, item) => sum + item.capacity, 0);
      shrinkable.forEach(({ index, capacity }) => {
        const shrink = Math.min(capacity, (overflow * capacity) / totalCapacity);
        result[index] -= shrink;
      });

      overflow = result.reduce((sum, width) => sum + width, 0) - targetTotal;
    }

    return result;
  }

  destroy(): void {
    this.dom.removeEventListener('pointermove', this.handleTablePointerMove, true);
    this.dom.removeEventListener('pointerleave', this.clearRowResizeCursor, true);
    this.dom.removeEventListener('pointerdown', this.handleTablePointerDown, true);
    this.dom.removeEventListener('mousedown', this.handleTableMouseDownCapture, true);
    this.dom.removeEventListener('mouseup', this.handleTableMouseUpCapture, true);
    window.removeEventListener('mouseup', this.handleTableMouseUpCapture, true);
    this.dom.removeEventListener('wheel', this.handleTableWheel, true);
    document.getElementById('editor-scroll-area')?.removeEventListener('scroll', this.handleEditorScrollForStickyHeader);
    this.removeStickyHeader();
    if (this.scrollable) {
      this.scrollable.removeEventListener('scroll', this.handleScrollableScroll);
    }
    if (this.layoutSyncFrame !== null) {
      cancelAnimationFrame(this.layoutSyncFrame);
      this.layoutSyncFrame = null;
    }
    this.rowResizeCleanup?.();

    // Clean up
    if (this.scrollable) {
      this.scrollable.remove();
      this.scrollable = null;
    }
    if (this.controlsContainer) {
      this.controlsContainer.remove();
      this.controlsContainer = null;
    }
    if (this.columnControlsContainer) {
      this.columnControlsContainer.remove();
      this.columnControlsContainer = null;
    }
    if (this.gripToolbar) {
      this.gripToolbar.destroy();
      this.gripToolbar = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    window.removeEventListener('easyview-table-wrap-layout-change', this.handleTableWrapLayoutChange);
  }
}
