/**
 * Re-export from @easyview/docx-core where the implementation now lives.
 * Kept for backward compatibility with in-package imports.
 */
export {
  type SplitCellDialogConfig,
  getSplitCellDialogConfig,
  splitActiveTableCell,
} from '@easyview/docx-core/prosemirror/commands';
