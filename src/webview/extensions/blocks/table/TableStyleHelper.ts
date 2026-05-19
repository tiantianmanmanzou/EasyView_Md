/**
 * TableStyleHelper
 *
 * CSS class name constants for table elements.
 * Provides a centralized location for all CSS class names used in tables.
 */

export class TableStyleHelper {
  // Table wrapper and container
  static readonly table = "table-wrapper";
  static readonly tableScrollable = "table-scrollable";

  // Table grips
  static readonly tableGrip = "table-grip";
  static readonly tableGripRow = "table-grip-row";
  static readonly tableGripColumn = "table-grip-column";

  // Add buttons
  static readonly tableAddColumn = "table-add-column";
  static readonly tableAddRow = "table-add-row";

  // Shadow classes
  static readonly tableShadowLeft = "table-shadow-left";
  static readonly tableShadowRight = "table-shadow-right";

  // Selection states
  static readonly selected = "selected";
  static readonly first = "first";
  static readonly last = "last";

  // Drag states
  static readonly dragging = "dragging";
  static readonly dragOver = "drag-over";

  // Alignment
  static readonly alignLeft = "align-left";
  static readonly alignCenter = "align-center";
  static readonly alignRight = "align-right";
}
