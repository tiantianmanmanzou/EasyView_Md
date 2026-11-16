/**
 * x-data-spreadsheet refocuses the selector's hidden IME input whenever the selection is placed,
 * including on load and reload. Opening a workbook would then pull focus out of a field the user is
 * typing in elsewhere (the file tree's rename box), and blurring that field ends the edit.
 */
import { isTextField } from './spreadsheetPaste';

/**
 * Keep the sheet's hidden inputs from taking focus away from a text field outside `mount`, or from
 * another webview / window while the sheet's page is in the background.
 */
export function guardSpreadsheetFocus(mount: HTMLElement): void {
  for (const input of mount.querySelectorAll<HTMLInputElement>('.hide-input input')) {
    const focus = input.focus.bind(input);
    input.focus = (options?: FocusOptions) => {
      const ownerDocument = input.ownerDocument;
      const active = ownerDocument.activeElement;
      if (!ownerDocument.hasFocus()) return;
      if (active !== input && isTextField(active) && !mount.contains(active)) return;
      focus(options);
    };
  }
}
