/**
 * Shared ASCII-art diagram source helpers for DOCX export.
 *
 * Keep this file DOM-free so host, webview, and unit tests can import it.
 * The rendering to a PNG lives in AsciiDiagramRenderer.ts.
 */

const ASCII_FENCE_LANGS = new Set(['text', 'txt', 'ascii', 'box', 'art', 'diagram']);

// Box-drawing / ASCII frame characters used to recognise an ASCII diagram.
const BOX_CHARS = /[─━│┃┌┐└┘├┤┬┴┼╔╗╚╝║╬═╠╣╦╩╭╮╯╰+|=-]/;

export function normalizeAsciiSource(source: string): string {
  return source.replace(/\r\n/g, '\n').trim();
}

export function isAsciiFenceInfo(info: string): boolean {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() || '';
  return ASCII_FENCE_LANGS.has(lang);
}

/**
 * Heuristic: an ASCII diagram is a multi-line block that contains a clear
 * horizontal border row (≥4 consecutive horizontal frame characters) plus at
 * least one more frame/box row. This avoids matching ordinary prose/code.
 */
export function looksLikeAsciiArt(source: string): boolean {
  const lines = normalizeAsciiSource(source).split('\n');
  if (lines.length < 2) return false;

  let borderRows = 0;
  let frameRows = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    // A border row starts with a corner/tee/edge and runs horizontal frame chars,
    // or contains a long run of horizontal frame characters.
    if (
      /^[┌└├╔╚╠][─━═-]/.test(trimmed) ||
      /[─━═-]{4,}/.test(line) ||
      /^[-+]{4,}/.test(trimmed)
    ) {
      borderRows++;
    } else if (BOX_CHARS.test(line)) {
      frameRows++;
    }
  }
  return borderRows >= 1 && borderRows + frameRows >= 2;
}

/**
 * Pull ASCII-diagram fences out of a Markdown source. A fence is treated as an
 * ASCII diagram when its language is text-like (`text`, `txt`, `ascii`, ...) or,
 * for an unlabelled fence, when the content looks like ASCII art.
 */
export function extractAsciiSourcesFromMarkdown(markdown: string): string[] {
  const sources: string[] = [];
  const normalized = markdown.replace(/\r\n/g, '\n');
  const fenceRe = /^```[ \t]*([^\n`]*)\n([\s\S]*?)^```/gim;

  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(normalized))) {
    const info = (match[1] ?? '').trim();
    const source = normalizeAsciiSource(match[2] ?? '');
    if (!source) continue;
    if (isAsciiFenceInfo(info) || looksLikeAsciiArt(source)) {
      sources.push(source);
    }
  }
  return sources;
}
