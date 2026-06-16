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

  constructor(node: ProsemirrorNode, cellMinWidth: number) {
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
    this.updateControls(node);
    this.syncWrappedColumnWidths();

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
        this.updateClassList(this.node);
        this.updateControls(this.node);
        this.syncWrappedColumnWidths();
      }
    }, 100);

    // ResizeObserver: update grips when table dimensions change (e.g. column resize)
    this.resizeObserver = new ResizeObserver(() => {
      if (this.dom && this.node) {
        this.updateClassList(this.node);
        this.updateControls(this.node);
        this.syncWrappedColumnWidths();
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
          this.updateClassList(this.node);
          this.updateControls(this.node);
          this.syncWrappedColumnWidths();
        }
      });
    }
    return result;
  }

  /**
   * Create and position control elements (grips and add buttons)
   */
  private updateControls(node: ProsemirrorNode): void {
    if (!this.controlsContainer || !this.columnControlsContainer || !this.table || !getEditorView()) return;

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

    const map = TableMap.get(node);
    const rows = this.table.querySelectorAll('tr');
    const firstRow = rows[0];

    if (!firstRow) return;

    // Column grips and add buttons (inside scrollable)
    const cells = firstRow.querySelectorAll('td, th');
    const paddingLeft = 20; // padding-left of .table-scrollable

    cells.forEach((cell, colIndex) => {
      const rect = cell.getBoundingClientRect();
      const containerRect = this.table.getBoundingClientRect();

      // Column grip (with gap for table border)
      const colGrip = document.createElement('div');
      colGrip.className = TableStyleHelper.tableGripColumn;
      colGrip.dataset.index = String(colIndex);
      colGrip.style.position = 'absolute';
      colGrip.style.left = `${rect.left - containerRect.left + paddingLeft + 0.5}px`;
      colGrip.style.top = '0px'; // Keep grip in the top control band, avoid overlapping header text
      colGrip.style.width = `${rect.width - 1}px`;
      colGrip.style.height = '8px';
      if (colIndex === 0) {
        colGrip.classList.add(TableStyleHelper.first);
        colGrip.style.left = `${rect.left - containerRect.left + paddingLeft}px`;
        colGrip.style.width = `${rect.width - 0.5}px`;
      }
      if (colIndex === cells.length - 1) {
        colGrip.classList.add(TableStyleHelper.last);
        colGrip.style.width = `${rect.width - 0.5}px`;
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
      addCol.style.left = `${rect.right - containerRect.left + paddingLeft - 10}px`;
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
        addColBefore.style.left = `${rect.left - containerRect.left + paddingLeft - 10}px`;
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
    const paddingLeftOffset = 20; // Compensate for .table-scrollable padding-left

    rows.forEach((row, rowIndex) => {
      const firstCell = row.querySelector('td, th');
      if (!firstCell) return;

      const rect = firstCell.getBoundingClientRect();
      const containerRect = this.dom.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();

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
      rowGrip.style.left = `${paddingLeftOffset - 16}px`; // 20px padding - 16px offset
      rowGrip.style.top = `${rowRect.top - containerRect.top + 0.5}px`;
      rowGrip.style.width = '12px';
      rowGrip.style.height = `${rowRect.height - 1}px`;
      if (rowIndex === 0) {
        rowGrip.classList.add(TableStyleHelper.first);
        rowGrip.style.top = `${rowRect.top - containerRect.top}px`;
        rowGrip.style.height = `${rowRect.height - 0.5}px`;
      }
      if (rowIndex === rows.length - 1) {
        rowGrip.classList.add(TableStyleHelper.last);
        rowGrip.style.height = `${rowRect.height - 0.5}px`;
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
        tableCommands.selectRow(rowIndex)(view.state, (tr) => {
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
      addRow.style.left = `${paddingLeftOffset - 32}px`; // 20px padding - 32px offset
      addRow.style.top = `${rowRect.bottom - containerRect.top - 10}px`;
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
        addRowBefore.style.left = `${paddingLeftOffset - 32}px`; // 20px padding - 32px offset
        addRowBefore.style.top = `${rowRect.top - containerRect.top - 10}px`;
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
    const firstRowRect = firstRow.getBoundingClientRect();
    const tableTopOffset = firstRowRect.top - this.dom.getBoundingClientRect().top;
    const tableGrip = document.createElement('div');
    tableGrip.className = TableStyleHelper.tableGrip;
    tableGrip.style.position = 'absolute';
    tableGrip.style.left = `${paddingLeftOffset - 16}px`; // 20px padding - 16px offset
    tableGrip.style.top = `${tableTopOffset - 16}px`; // Anchor to actual table top-left corner
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

    this.table.classList.remove('table-balanced-wrap');
    updateColumnsOnResize(this.node, this.colgroup, this.table, this.defaultCellMinWidth);
  }

  private syncWrappedColumnWidths(): void {
    if (!this.node || !this.table || !this.colgroup || this.node.type.name !== 'table') return;

    if (!this.isWrapMode() || this.hasManualColumnWidths(this.node)) {
      this.resetBalancedColumnWidths();
      return;
    }

    const map = TableMap.get(this.node);
    if (map.width <= 0) {
      this.resetBalancedColumnWidths();
      return;
    }

    const scores = new Array<number>(map.width).fill(0);
    const counts = new Array<number>(map.width).fill(0);
    const maxScores = new Array<number>(map.width).fill(0);
    const seen = new Set<number>();

    for (const pos of map.map) {
      if (seen.has(pos)) continue;
      seen.add(pos);

      const cell = this.node.nodeAt(pos);
      if (!cell) continue;

      const rect = map.findCell(pos);
      const colspan = Math.max(1, rect.right - rect.left);
      const score = this.scoreCellContent(cell) / colspan;

      for (let col = rect.left; col < rect.right; col++) {
        scores[col] += score;
        counts[col] += 1;
        maxScores[col] = Math.max(maxScores[col], score);
      }
    }

    const weights = scores.map((score, index) => {
      const avg = score / Math.max(1, counts[index]);
      const max = maxScores[index];
      return Math.max(1, Math.sqrt(avg * 0.7 + max * 0.3));
    });
    const widths = this.normalizeColumnPercents(weights);

    const cols = Array.from(this.colgroup.children) as HTMLTableColElement[];
    widths.forEach((width, index) => {
      const col = cols[index];
      if (!col) return;
      col.style.width = `${width.toFixed(2)}%`;
    });

    this.table.style.width = '100%';
    this.table.style.minWidth = '';
    this.table.classList.add('table-balanced-wrap');
  }

  private scoreCellContent(cell: ProsemirrorNode): number {
    const text = cell.textContent.trim();
    if (!text) return 2;

    const chineseChars = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
    const asciiRuns = text.match(/[A-Za-z0-9_./:@#?&=%+-]+/g) ?? [];
    const asciiScore = asciiRuns.reduce((sum, word) => {
      const longTokenPenalty = word.length > 18 ? word.length * 0.8 : word.length * 0.45;
      return sum + longTokenPenalty;
    }, 0);
    const punctuationScore = Math.min(8, (text.match(/[，。；：、,.!?;:()（）[\]{}<>《》|]/g) ?? []).length * 0.35);
    const codeBonus = this.hasCodeContent(cell) ? 8 : 0;

    return Math.max(2, chineseChars * 1.25 + asciiScore + punctuationScore + codeBonus);
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

  private normalizeColumnPercents(weights: number[]): number[] {
    if (weights.length === 0) return [];

    const minPercent = Math.min(14, Math.max(6, 56 / weights.length));
    const maxPercent = Math.min(46, Math.max(22, 160 / weights.length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || weights.length;
    let widths = weights.map((weight) => (weight / totalWeight) * 100);

    for (let i = 0; i < 6; i++) {
      widths = widths.map((width) => Math.min(maxPercent, Math.max(minPercent, width)));
      const total = widths.reduce((sum, width) => sum + width, 0);
      if (Math.abs(total - 100) < 0.01) break;

      const adjustableIndexes = widths
        .map((width, index) => ({ width, index }))
        .filter(({ width }) => (total > 100 ? width > minPercent : width < maxPercent))
        .map(({ index }) => index);

      if (adjustableIndexes.length === 0) break;

      const delta = (100 - total) / adjustableIndexes.length;
      adjustableIndexes.forEach((index) => {
        widths[index] += delta;
      });
    }

    const total = widths.reduce((sum, width) => sum + width, 0) || 100;
    return widths.map((width) => (width / total) * 100);
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
