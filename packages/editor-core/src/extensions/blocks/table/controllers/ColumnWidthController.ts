import type { EditorView } from 'prosemirror-view';
import * as tableCommands from '../TableCommands';

export class ColumnWidthController {
  adjust(view: EditorView, columnIndex: number, delta: number, fallbackWidth = 120): boolean {
    return tableCommands.adjustColumnWidth({ index: columnIndex, delta, fallbackWidth })(view.state, view.dispatch);
  }

  set(view: EditorView, columnIndex: number, width: number, fallbackWidth = 120): boolean {
    return tableCommands.setColumnWidth({ index: columnIndex, width, fallbackWidth })(view.state, view.dispatch);
  }
}
