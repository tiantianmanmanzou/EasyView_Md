import type { Node as ProsemirrorNode } from "prosemirror-model";
import type { NodeView, ViewMutationRecord } from "prosemirror-view";

/**
 * A row with an explicit height uses the cell content DOM as a vertical scroll
 * viewport. Native `td { vertical-align }` cannot move a viewport that already
 * fills all remaining cell height, so opt into a scoped layout mode only when
 * the complete cell content fits inside that viewport.
 *
 * Overflowing content deliberately stays top-aligned: centering/end-aligning a
 * scrollable overflow makes its first lines inaccessible at scrollTop = 0.
 */
export function syncTableCellVerticalAlignmentLayout(
  cell: HTMLTableCellElement,
  content: HTMLDivElement | null,
): void {
  if (!content) return;

  const verticalAlignment = cell.style.verticalAlign;
  const hasFixedRowHeight = cell.hasAttribute("data-easyview-row-resized");
  const availableHeight = content.clientHeight;
  const contentFits =
    availableHeight > 0 && content.scrollHeight <= availableHeight + 1;

  if (
    hasFixedRowHeight &&
    contentFits &&
    (verticalAlignment === "middle" || verticalAlignment === "bottom")
  ) {
    content.dataset.easyviewVerticalAlignment = verticalAlignment;
  } else {
    delete content.dataset.easyviewVerticalAlignment;
  }
}

/**
 * Gives each table cell an internal content viewport. The outer element remains
 * a real td/th so prosemirror-tables can continue to locate and resize cells.
 */
export class TableCellView implements NodeView {
  dom: HTMLTableCellElement;
  contentDOM: HTMLDivElement;
  private node: ProsemirrorNode;
  private verticalAlignmentSyncFrame: number | null = null;
  private readonly contentMutationObserver: MutationObserver;

  constructor(node: ProsemirrorNode) {
    this.node = node;
    this.dom = document.createElement(
      node.type.name === "table_header" ? "th" : "td",
    );
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "easyview-table-cell-content";
    this.dom.appendChild(this.contentDOM);
    this.contentMutationObserver = new MutationObserver(() => {
      this.scheduleVerticalAlignmentLayoutSync();
    });
    this.contentMutationObserver.observe(this.contentDOM, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    this.syncAttributes(node);
  }

  update(node: ProsemirrorNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.syncAttributes(node);
    return true;
  }

  ignoreMutation(record: ViewMutationRecord): boolean {
    return (
      record.type === "attributes" &&
      (record.target === this.dom || record.target === this.contentDOM)
    );
  }

  destroy(): void {
    this.contentMutationObserver.disconnect();
    if (this.verticalAlignmentSyncFrame !== null) {
      cancelAnimationFrame(this.verticalAlignmentSyncFrame);
      this.verticalAlignmentSyncFrame = null;
    }
  }

  private scheduleVerticalAlignmentLayoutSync(): void {
    if (this.verticalAlignmentSyncFrame !== null) return;
    this.verticalAlignmentSyncFrame = requestAnimationFrame(() => {
      this.verticalAlignmentSyncFrame = null;
      syncTableCellVerticalAlignmentLayout(this.dom, this.contentDOM);
    });
  }

  private syncAttributes(node: ProsemirrorNode): void {
    const { colspan, rowspan, colwidth, alignment, verticalAlignment } =
      node.attrs;

    this.dom.colSpan = colspan || 1;
    this.dom.rowSpan = rowspan || 1;
    const hasExplicitColumnWidth =
      Array.isArray(colwidth) &&
      colwidth.some(
        (width) =>
          typeof width === "number" && Number.isFinite(width) && width > 0,
      );
    if (hasExplicitColumnWidth) {
      this.dom.dataset.colwidth = colwidth.join(",");
    } else {
      delete this.dom.dataset.colwidth;
    }
    this.dom.toggleAttribute(
      "data-easyview-column-resized",
      hasExplicitColumnWidth,
    );

    this.dom.style.textAlign = alignment || "";
    this.dom.style.verticalAlign = verticalAlignment || "";
    syncTableCellVerticalAlignmentLayout(this.dom, this.contentDOM);
  }
}
