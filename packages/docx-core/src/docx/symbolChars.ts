// i18n-ignore-file: glyph tables, not user-facing copy.
/**
 * `w:sym` glyphs → Unicode. A symbol run names a symbol font and a code in it (Wingdings 2 "R" is
 * the ticked box of Chinese forms); without that font the code shows as a letter or nothing.
 */

const SYMBOL_GLYPHS: Record<string, Record<number, string>> = {
  'wingdings 2': {
    0x4f: '✗',
    0x50: '✓',
    0x52: '☑',
    0x54: '☒',
    0xa3: '☐',
  },
  wingdings: {
    0x6e: '■',
    0x6f: '□',
    0xa8: '◻',
    0xfb: '✗',
    0xfc: '✓',
    0xfd: '☒',
    0xfe: '☑',
  },
};

/** Text shown for `<w:sym w:font w:char>`; unknown codes keep the symbol-font private-use code point. */
export function symbolText(font: string, char: string): string {
  const raw = Number.parseInt(char, 16);
  if (!Number.isFinite(raw)) return '';
  const code = raw >= 0xf000 ? raw - 0xf000 : raw;
  return SYMBOL_GLYPHS[font.trim().toLowerCase()]?.[code] ?? String.fromCodePoint(0xf000 + code);
}
