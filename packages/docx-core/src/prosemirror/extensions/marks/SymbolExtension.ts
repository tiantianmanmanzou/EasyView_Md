/**
 * Symbol Mark Extension (w:sym)
 *
 * The marked text is the Unicode stand-in for a symbol-font glyph; export writes the original
 * `<w:sym w:font w:char>` back.
 */

import { createMarkExtension } from '../create';

export const SymbolExtension = createMarkExtension({
  name: 'symbol',
  schemaMarkName: 'symbol',
  markSpec: {
    attrs: {
      font: {},
      char: {},
    },
    inclusive: false,
    parseDOM: [
      {
        tag: 'span.docx-symbol',
        getAttrs: (dom) => {
          const element = dom as HTMLElement;
          return { font: element.dataset.font || '', char: element.dataset.char || '' };
        },
      },
    ],
    toDOM(mark) {
      const attrs = mark.attrs as { font: string; char: string };
      return ['span', { class: 'docx-symbol', 'data-font': attrs.font, 'data-char': attrs.char }, 0];
    },
  },
});
