/** @vitest-environment happy-dom */
import { afterEach, expect, it } from 'vitest';
import { guardSpreadsheetFocus } from './spreadsheetFocus';

afterEach(() => { document.body.replaceChildren(); });

function setup() {
  document.body.innerHTML = '<input class="rename"><div class="mount"><input class="toolbar-field"><div class="hide-input"><input></div></div>';
  const mount = document.querySelector<HTMLElement>('.mount')!;
  guardSpreadsheetFocus(mount);
  return {
    rename: document.querySelector<HTMLInputElement>('.rename')!,
    toolbarField: document.querySelector<HTMLInputElement>('.toolbar-field')!,
    hidden: document.querySelector<HTMLInputElement>('.hide-input input')!,
  };
}

it('leaves focus in a text field outside the sheet when the sheet places its selection', () => {
  const { rename, hidden } = setup();
  rename.focus();
  hidden.focus();
  expect(document.activeElement).toBe(rename);
});

it('still takes focus from the page body and from fields inside the sheet', () => {
  const { toolbarField, hidden } = setup();
  hidden.focus();
  expect(document.activeElement).toBe(hidden);
  toolbarField.focus();
  hidden.focus();
  expect(document.activeElement).toBe(hidden);
});
