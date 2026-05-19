/**
 * PdfEmojiUtils — Emoji detection, splitting, and coloring utilities for PDF export.
 */

/** Blend a hex color with white at given opacity (0..1) -> solid hex */
export function lightenHex(hex: string, opacity: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  const lr = Math.round(r * opacity + 255 * (1 - opacity));
  const lg = Math.round(g * opacity + 255 * (1 - opacity));
  const lb = Math.round(b * opacity + 255 * (1 - opacity));
  return '#' + [lr, lg, lb].map(c => c.toString(16).padStart(2, '0')).join('');
}

/**
 * Emoji detection regex — matches most Unicode emoji ranges including:
 * - Emoticons, Dingbats, Symbols, Transport/Map, Misc Symbols
 * - Skin tone modifiers, ZWJ sequences, Regional indicators (flags)
 * - Enclosed characters, Supplemental symbols
 */
export const EMOJI_RE = /(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(?:\u200D(?:\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/gu;

/** Unicode symbols that Roboto doesn't have but NotoEmoji does (checkmarks, ballot boxes, etc.) */
const SYMBOL_RE = /[\u2600-\u27BF\u2B50-\u2B55\u2702-\u27B0\u2300-\u23FF\u25A0-\u25FF\u2610-\u2612\u2713-\u2717\u2190-\u21FF]/g;

/**
 * Split text into segments of regular text and emoji/symbol text.
 * Returns array of { text, isEmoji } objects.
 */
export function splitEmoji(text: string): Array<{ text: string; isEmoji: boolean }> {
  const combined = new RegExp(`${EMOJI_RE.source}|${SYMBOL_RE.source}`, 'gu');
  const result: Array<{ text: string; isEmoji: boolean }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = combined.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push({ text: text.slice(lastIndex, match.index), isEmoji: false });
    }
    result.push({ text: match[0], isEmoji: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    result.push({ text: text.slice(lastIndex), isEmoji: false });
  }

  return result.length > 0 ? result : [{ text, isEmoji: false }];
}

// ─── Emoji Color Map ─────────────────────────────────────────────────────────
// Maps simple-shape emoji to their primary color. Complex emoji (faces, people,
// detailed objects) are left black because Noto Emoji's monochrome glyphs lose
// internal detail when tinted a single color.

export const EMOJI_COLOR_MAP: Record<string, string> = {
  // Hearts
  '❤': '#e53935', '❤️': '#e53935', '🧡': '#f57c00', '💛': '#fdd835',
  '💚': '#43a047', '💙': '#1e88e5', '💜': '#8e24aa', '🖤': '#333333',
  '🤍': '#999999', '🤎': '#795548', '💗': '#ec407a', '💖': '#ec407a',
  '💕': '#ec407a', '💞': '#ec407a', '💓': '#ec407a', '💘': '#ec407a',
  '💝': '#ec407a', '💔': '#e53935', '❣': '#e53935', '❣️': '#e53935',

  // Stars & sparkles
  '⭐': '#fdd835', '🌟': '#fdd835', '✨': '#fdd835', '💫': '#fdd835',
  '⚡': '#fdd835', '🔥': '#f57c00',

  // Circles & shapes
  '🔴': '#e53935', '🟠': '#f57c00', '🟡': '#fdd835', '🟢': '#43a047',
  '🔵': '#1e88e5', '🟣': '#8e24aa', '🟤': '#795548', '⚫': '#333333',
  '⚪': '#999999', '🔶': '#f57c00', '🔷': '#1e88e5', '🔸': '#f57c00',
  '🔹': '#1e88e5', '🔺': '#e53935', '🔻': '#e53935',
  '🟥': '#e53935', '🟧': '#f57c00', '🟨': '#fdd835',
  '🟩': '#43a047', '🟦': '#1e88e5', '🟪': '#8e24aa',

  // Nature — simple shapes
  '🌲': '#2e7d32', '🌳': '#2e7d32', '🌴': '#2e7d32', '🌿': '#43a047',
  '☘': '#43a047', '☘️': '#43a047', '🍀': '#43a047', '🌱': '#43a047',
  '🍃': '#43a047', '🍂': '#a1887f', '🍁': '#e53935',
  '🌸': '#f48fb1', '🌺': '#e53935', '🌻': '#fdd835', '🌼': '#fdd835',
  '🌷': '#e53935', '🌹': '#e53935', '💐': '#e53935',

  // Weather & sky
  '☀': '#fdd835', '☀️': '#fdd835', '🌙': '#fdd835', '🌕': '#fdd835',
  '⛅': '#90a4ae', '☁': '#90a4ae', '☁️': '#90a4ae',
  '❄': '#42a5f5', '❄️': '#42a5f5', '🌊': '#1e88e5',
  '💧': '#42a5f5', '💦': '#42a5f5', '🌈': '#e53935',

  // Fruits — simple shapes
  '🍎': '#e53935', '🍏': '#43a047', '🍊': '#f57c00', '🍋': '#fdd835',
  '🍇': '#8e24aa', '🍓': '#e53935', '🍒': '#e53935', '🍑': '#f57c00',
  '🥝': '#689f38', '🍌': '#fdd835', '🍈': '#a5d6a7', '🍐': '#8bc34a',

  // Symbols & marks
  '✅': '#43a047', '❌': '#e53935', '❎': '#43a047',
  '✔': '#43a047', '✔️': '#43a047', '✖': '#e53935', '✖️': '#e53935',
  '➕': '#43a047', '➖': '#e53935', '➗': '#757575',
  '‼': '#e53935', '‼️': '#e53935', '⁉': '#e53935', '⁉️': '#e53935',
  '❗': '#e53935', '❕': '#f57c00', '❓': '#e53935', '❔': '#f57c00',
  '⚠': '#f57c00', '⚠️': '#f57c00',
  '🚫': '#e53935', '⛔': '#e53935', '🔞': '#e53935',
  '♻': '#43a047', '♻️': '#43a047',

  // Arrows
  '➡': '#1e88e5', '➡️': '#1e88e5', '⬅': '#1e88e5', '⬅️': '#1e88e5',
  '⬆': '#1e88e5', '⬆️': '#1e88e5', '⬇': '#1e88e5', '⬇️': '#1e88e5',
  '↗': '#1e88e5', '↗️': '#1e88e5', '↘': '#1e88e5', '↘️': '#1e88e5',
  '↙': '#1e88e5', '↙️': '#1e88e5', '↖': '#1e88e5', '↖️': '#1e88e5',
  '🔄': '#1e88e5', '🔃': '#1e88e5',

  // Misc simple
  '💰': '#fdd835', '💵': '#43a047', '💴': '#fdd835', '💶': '#1e88e5',
  '💷': '#8e24aa', '💎': '#42a5f5', '🏆': '#fdd835', '🥇': '#fdd835',
  '🥈': '#bdbdbd', '🥉': '#a1887f',
  '🎵': '#333333', '🎶': '#333333', '🎯': '#e53935',
  '📍': '#e53935', '📌': '#e53935',
  '🔑': '#fdd835', '🗝': '#a1887f', '🗝️': '#a1887f',
};

/**
 * Get the primary display color for a simple-shape emoji.
 * Returns undefined for complex emoji (faces, people, objects with detail).
 */
export function getEmojiColor(emoji: string): string | undefined {
  // Direct lookup
  const color = EMOJI_COLOR_MAP[emoji];
  if (color) return color;
  // Strip variation selector U+FE0F and try again
  const stripped = emoji.replace(/\uFE0F/g, '');
  if (stripped !== emoji) return EMOJI_COLOR_MAP[stripped];
  return undefined;
}

/**
 * Split code block segments (from syntax highlighting) to handle emoji.
 * Emoji characters get font: 'NotoEmoji', others stay with the parent RobotoMono.
 */
export function splitCodeSegmentsForEmoji(
  segments: Array<{ text: string; color?: string }>
): Array<{ text: string; color?: string; font?: string }> {
  const result: Array<{ text: string; color?: string; font?: string }> = [];
  for (const seg of segments) {
    const parts = splitEmoji(seg.text);
    if (parts.length === 1 && !parts[0].isEmoji) {
      result.push(seg);
    } else {
      for (const part of parts) {
        if (part.isEmoji) {
          result.push({ text: part.text, color: seg.color, font: 'NotoEmoji' });
        } else {
          result.push({ text: part.text, color: seg.color });
        }
      }
    }
  }
  return result;
}

/**
 * Takes a pdfmake text object and splits it into segments,
 * wrapping emoji/symbol characters with font: 'NotoEmoji'.
 * Simple-shape emoji are tinted with their primary color for visual appeal.
 */
export function wrapWithEmojiFont(textObj: any): any[] {
  const rawText = typeof textObj === 'string' ? textObj : textObj?.text;
  if (!rawText || typeof rawText !== 'string') return [textObj];

  const parts = splitEmoji(rawText);
  if (parts.length === 1 && !parts[0].isEmoji) return [textObj];

  // Has emoji — split into segments
  const baseProps = typeof textObj === 'string' ? {} : { ...textObj };
  delete baseProps.text;

  return parts.map(part => {
    if (part.isEmoji) {
      const emojiColor = getEmojiColor(part.text);
      const seg: any = { ...baseProps, text: part.text, font: 'NotoEmoji' };
      if (emojiColor) seg.color = emojiColor;
      return seg;
    }
    if (Object.keys(baseProps).length === 0) return part.text;
    return { ...baseProps, text: part.text };
  });
}
