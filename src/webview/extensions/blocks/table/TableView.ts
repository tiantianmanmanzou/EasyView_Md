/**
 * TableView — ProseMirror NodeView for tables
 *
 * Creates table wrapper with controls as DOM elements (not decorations)
 * This approach avoids the content-shifting issues with widget decorations.
 */

import type { Node as ProsemirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { TableView as ProsemirrorTableView, TableMap, updateColumnsOnResize } from 'prosemirror-tables';
import { TableStyleHelper } from './TableStyleHelper';
import * as tableCommands from './TableCommands';
import { getEditorView } from '../../../index';
import { TableGripToolbar } from './TableGripToolbar';
import { isColumnSelection, isRowSelection, isTableSelected } from './TableQueries';

export class TableView extends ProsemirrorTableView {
  private scrollable: HTMLDivElement | null = null;
  private controlsContainer: HTMLDivElement | null = null;
  private columnControlsContainer: HTMLDivElement | null = null;
  private gripToolbar: TableGripToolbar | null = null;
  private toolbarRequest: { type: 'row' | 'column' | 'table', index: number } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly handleTableWrapLayoutChange = (): void => {
    requestAnimationFrame(() => this.syncWrappedColumnWidths());
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

    // Create row controls container (OUTSIDE scrollable - fixed position)
    this.controlsContainer = this.dom.appendChild(document.createElement('div'));
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

    // Create controls
    this.syncWrappedColumnWidths();
    this.updateControls(node);

    // Listen to scroll to update shadows and controls
    this.scrollable.addEventListener(
      'scroll',
      () => {
        this.updateClassList(this.node);
        this.updateControls(this.node);
      },
      { passive: true }
    );

    // Initial update
    this.updateClassList(node);
    window.addEventListener('easyview-table-wrap-layout-change', this.handleTableWrapLayoutChange);

    // Wait for DOM to render to ensure scroll shadows are correct
    setTimeout(() => {
        if (this.dom) {
        this.syncWrappedColumnWidths();
        this.updateClassList(this.node);
        this.updateControls(this.node);
      }
    }, 100);

    // ResizeObserver: update grips when table dimensions change (e.g. column resize)
    this.resizeObserver = new ResizeObserver(() => {
      if (this.dom && this.node) {
        this.syncWrappedColumnWidths();
        this.updateClassList(this.node);
        this.updateControls(this.node);
      }
    });
    this.resizeObserver.observe(this.table);
  }

  override update(node: ProsemirrorNode): boolean {
    const result = super.update(node);
    if (result) {
      // Defer both updates to avoid interfering with resize
      requestAnimationFrame(() => {
        if (this.dom && this.node) {
          this.syncWrappedColumnWidths();
          this.updateClassList(this.node);
          this.updateControls(this.node);
        }
      });
    }
    return result;
  }

  /**
   * Create and position control elements (grips and add buttons)
   */
  private updateControls(node: ProsemirrorNode): void {
    if (!this.controlsContainer || !this.columnControlsContainer || !this.scrollable || !this.table || !getEditorView()) return;

    // Check if we have a toolbar request from grip click, otherwise save current state
    let toolbarToShow: { type: 'row' | 'column' | 'table', index: number } | null = null;

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
    const rows = this.table.querySelectorAll('tr');
    const firstRow = rows[0];

    if (!firstRow) return;

    const wrapperRect = this.dom.getBoundingClientRect();
    const tableRect = this.table.getBoundingClientRect();
    const tableTopOffset = tableRect.top - wrapperRect.top;
    const tableLeftOffset = tableRect.left - wrapperRect.left;
    this.controlsContainer.style.top = `${tableTopOffset}px`;
    this.controlsContainer.style.height = `${tableRect.height}px`;
    this.controlsContainer.style.overflow = 'visible';
    this.controlsContainer.style.setProperty('--table-row-control-bg-left', `${tableLeftOffset - 20}px`);

    // Column grips and add buttons (inside scrollable)
    const columnSegments = this.getRenderedColumnSegments(node, map, tableRect);
    this.columnControlsContainer.style.left = `${this.table.offsetLeft}px`;
    this.columnControlsContainer.style.width = `${this.table.offsetWidth}px`;
    this.columnControlsContainer.style.top = '0px';
    this.columnControlsContainer.style.height = '8px';

    columnSegments.forEach((segment, colIndex) => {
      const left = segment.left;
      const right = segment.right;

      // Column grip (with gap for table border)
      const colGrip = document.createElement('div');
      colGrip.className = TableStyleHelper.tableGripColumn;
      colGrip.dataset.index = String(colIndex);
      colGrip.style.position = 'absolute';
      colGrip.style.left = `${left + 0.5}px`;
      colGrip.style.top = '2px'; // Keep grip in the top control band, avoid overlapping header text
      colGrip.style.width = `${Math.max(0, right - left - 1)}px`;
      colGrip.style.height = '4px';
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

        // Set toolbar request flag - will be shown after grips are recreated
        this.toolbarRequest = { type: 'column', index: colIndex };

        // Select column and mark as grip selection
        // This will trigger update() -> updateControls() which will show toolbar on new grip
        tableCommands.selectColumn(colIndex)(view.state, (tr) => {
          tr.setMeta('gripSelection', true);
          view.dispatch(tr);
        });
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
      const firstCell = row.querySelector('td, th');
      if (!firstCell) return;

      const rowRect = row.getBoundingClientRect();
      const rowTop = rowRect.top - tableRect.top;

      // Check if this row is a header (contains th elements)
      const isHeaderRow = row.querySelector('th') !== null;

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
      rowGrip.style.height = `${rowRect.height - 1}px`;
      if (rowIndex === 0) {
        rowGrip.classList.add(TableStyleHelper.first);
        rowGrip.style.top = `${rowTop}px`;
        rowGrip.style.height = `${rowRect.height - 0.5}px`;
      }
      if (rowIndex === rows.length - 1) {
        rowGrip.classList.add(TableStyleHelper.last);
        rowGrip.style.height = `${rowRect.height - 0.5}px`;
      }
      if (selectedRows.has(rowIndex)) {
        rowGrip.classList.add(TableStyleHelper.selected);
      }
      rowGrip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const view = getEditorView();
        if (!view) return;

        // Set toolbar request flag - will be shown after grips are recreated
        this.toolbarRequest = { type: 'row', index: rowIndex };

        // Select row and mark as grip selection
        // This will trigger update() -> updateControls() which will show toolbar on new grip
        tableCommands.selectRow(rowIndex, e.shiftKey)(view.state, (tr) => {
          tr.setMeta('gripSelection', true);
          view.dispatch(tr);
        });
      });

      this.controlsContainer.appendChild(rowGrip);

      // Add row button (after each row)
      const addRow = document.createElement('div');
      addRow.className = TableStyleHelper.tableAddRow;
      addRow.dataset.index = String(rowIndex + 1);
      addRow.style.position = 'absolute';
      addRow.style.left = `${tableLeftOffset - 32}px`;
      addRow.style.top = `${rowRect.bottom - tableRect.top - 10}px`;
      addRow.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const view = getEditorView();
        if (view) {
          tableCommands.addRowBefore({ index: rowIndex + 1 })(view.state, view.dispatch);
        }
      });
      this.controlsContainer.appendChild(addRow);

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
        this.controlsContainer.appendChild(addRowBefore);
      }
    });

    // Table grip (corner)
    const tableGrip = document.createElement('div');
    tableGrip.className = TableStyleHelper.tableGrip;
    if (showTableGrip) {
      tableGrip.classList.add(TableStyleHelper.selected);
    }
    tableGrip.style.position = 'absolute';
    tableGrip.style.left = `${tableLeftOffset - 16}px`;
    tableGrip.style.top = '-14px'; // Anchor close to the actual table top-left corner.
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
    this.controlsContainer.appendChild(tableGrip);

    // Show toolbar immediately after grips are created
    if (toolbarToShow && this.gripToolbar) {
      // Use requestAnimationFrame to ensure grips are in DOM
      requestAnimationFrame(() => {
        if (!this.gripToolbar || !toolbarToShow) return;

        if (toolbarToShow.type === 'row') {
          const rowGrip = this.controlsContainer!.querySelector(`.${TableStyleHelper.tableGripRow}[data-index="${toolbarToShow.index}"]`) as HTMLElement;
          if (rowGrip) {
            this.gripToolbar.showForRow(rowGrip, toolbarToShow.index);
            this.toolbarRequest = null; // Clear request after successful show
          }
        } else if (toolbarToShow.type === 'column') {
          const colGrip = this.columnControlsContainer!.querySelector(`.${TableStyleHelper.tableGripColumn}[data-index="${toolbarToShow.index}"]`) as HTMLElement;
          if (colGrip) {
            this.gripToolbar.showForColumn(colGrip, toolbarToShow.index);
            this.toolbarRequest = null; // Clear request after successful show
          }
        } else if (toolbarToShow.type === 'table') {
          // Table grip doesn't have index, just find the table grip element
          const tableGripElement = this.controlsContainer!.querySelector(`.${TableStyleHelper.tableGrip}`) as HTMLElement;
          if (tableGripElement) {
            this.gripToolbar.showForTable(tableGripElement);
          }
        }
      });
    }
  }

  private getRenderedColumnSegments(
    node: ProsemirrorNode,
    map: TableMap,
    tableRect: DOMRect
  ): Array<{ left: number; right: number }> {
    const edges: Array<number | null> = new Array(map.width + 1).fill(null);
    const rows = Array.from(this.table.querySelectorAll('tr'));
    let rowStart = 0;

    for (let rowIndex = 0; rowIndex < Math.min(node.childCount, rows.length); rowIndex++) {
      const rowNode = node.child(rowIndex);
      const cells = Array.from(rows[rowIndex].querySelectorAll('td, th')) as HTMLTableCellElement[];
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
    // Ignore all mutations on the wrapper dom (class/style changes, drag handles, etc.)
    if (record.target === this.dom) {
      return true;
    }

    // Ignore changes to controls containers
    if (record.target === this.controlsContainer || this.controlsContainer?.contains(record.target as Node)) {
      return true;
    }

    if (record.target === this.columnControlsContainer || this.columnControlsContainer?.contains(record.target as Node)) {
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

    // Update scroll shadows
    const shadowLeft = this.scrollable.scrollLeft > 0;
    const shadowRight =
      this.scrollable.scrollWidth > this.scrollable.clientWidth &&
      this.scrollable.scrollLeft + this.scrollable.clientWidth <
        this.scrollable.scrollWidth - 1;

    this.dom.classList.toggle(TableStyleHelper.tableShadowLeft, shadowLeft);
    // table-shadow-right removed

    // Set CSS variables for table dimensions (used by hover line effects)
    // Use clientWidth/Height + grip width (12px) to reach the end
    this.dom.style.setProperty('--table-height', `${this.table.clientHeight + 12}px`);
    this.dom.style.setProperty('--table-width', `${this.table.clientWidth + 12}px`);
  }

  private isWrapMode(): boolean {
    return document.getElementById('editor')?.classList.contains('table-wrap') ?? false;
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
    updateColumnsOnResize(this.node, this.colgroup, this.table, this.defaultCellMinWidth);
    this.table.style.width = '';
    this.table.style.minWidth = '';
  }

  private applyManualWrappedColumnWidths(): void {
    if (!this.node || !this.colgroup || !this.table) return;

    updateColumnsOnResize(this.node, this.colgroup, this.table, this.defaultCellMinWidth);
    this.table.classList.remove(TableStyleHelper.tableBalancedWrap);
    this.table.classList.add(TableStyleHelper.tableManualWidth);
    this.table.style.width = 'max-content';
    this.table.style.minWidth = '100%';
  }

  private syncWrappedColumnWidths(): void {
    if (!this.node || !this.table || !this.colgroup || !this.scrollable || this.node.type.name !== 'table') return;

    if (!this.isWrapMode()) {
      this.resetBalancedColumnWidths();
      return;
    }

    if (this.hasManualColumnWidths(this.node)) {
      this.applyManualWrappedColumnWidths();
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
    const tableRows = Array.from(this.table.querySelectorAll('tr'));

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

  override destroy(): void {
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

    super.destroy?.();
  }
}
