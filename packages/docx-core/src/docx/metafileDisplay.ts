/**
 * Browser-safe display conversion for Windows metafiles (WMF / EMF).
 *
 * Equation Editor / Kingsoft Equation (`Equation.KSEE3`) and other OLE
 * formulas store a WMF preview under `v:imagedata`. Browsers cannot paint
 * `image/x-wmf` / `image/x-emf` data URLs, so the editor shows a broken-image
 * icon. We convert the metafile to SVG at parse time for display only —
 * `MediaFile.data` keeps the original bytes for round-trip.
 *
 * `wmf-emf-renderer` already selects DBCS fonts (charset 134 → 宋体), but its
 * ExtTextOut path only re-decodes GBK when a dx-array marks lead bytes. Many
 * formula WMFs omit that dx pattern, so Chinese text lands as Latin-1
 * mojibake in the SVG. We repair text nodes that decode cleanly to CJK.
 */

import {
  detectFileType,
  parseMetafile,
  renderToSvg,
  WmfDrawer,
} from 'wmf-emf-renderer';

const METAFILE_MIME = new Set(['image/x-wmf', 'image/x-emf', 'image/wmf', 'image/emf']);

/**
 * `wmf-emf-renderer` only re-decodes DBCS ExtTextOut when a dx array marks
 * lead bytes (`dx===0`). Equation WMFs usually omit that map, so charset=134
 * text is read as Latin-1. Patch `readStringFromData` for the duration of
 * ExtTextOut / TextOut so GBK (and siblings) decode correctly up front.
 */
let wmfGbkPatched = false;
function ensureWmfDbcsStringPatch(): void {
  if (wmfGbkPatched) return;
  wmfGbkPatched = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = WmfDrawer.prototype as any;
  const originalExt = proto.processExtTextOut as ((data: Uint8Array) => void) | undefined;
  const originalText = proto.processTextOut as ((data: Uint8Array) => void) | undefined;
  if (!originalExt && !originalText) return;

  const withDbcsRead = function (this: {
    currentCharset?: number;
    getDbcsCharsetLabel?: (charset: number) => string | null;
    readStringFromData: (data: Uint8Array, offset: number, length: number) => string;
  }, invoke: () => void): void {
    const label = this.getDbcsCharsetLabel?.(this.currentCharset ?? 0) ?? null;
    if (!label) {
      invoke();
      return;
    }
    const origRead = this.readStringFromData;
    this.readStringFromData = (data, offset, length) => {
      const end = Math.min(offset + length, data.length);
      const raw = data.slice(offset, end);
      try {
        return new TextDecoder(label).decode(raw);
      } catch {
        return origRead.call(this, data, offset, length);
      }
    };
    try {
      invoke();
    } finally {
      this.readStringFromData = origRead;
    }
  };

  if (originalExt) {
    proto.processExtTextOut = function (this: unknown, data: Uint8Array) {
      withDbcsRead.call(this as never, () => originalExt.call(this, data));
    };
  }
  if (originalText) {
    proto.processTextOut = function (this: unknown, data: Uint8Array) {
      withDbcsRead.call(this as never, () => originalText.call(this, data));
    };
  }
}

/** True when a MIME type (or path extension) is a Windows metafile. */
export function isMetafileMime(mimeType: string | undefined, path?: string): boolean {
  if (mimeType && METAFILE_MIME.has(mimeType.toLowerCase())) return true;
  const ext = path?.split('.').pop()?.toLowerCase();
  return ext === 'wmf' || ext === 'emf';
}

/**
 * Re-decode Latin-1 mojibake as GBK when the result contains CJK.
 * Leaves ASCII / Symbol singles (e.g. `×`) alone.
 */
export function repairGbkMojibakeText(text: string): string {
  if (text.length < 2) return text;
  const chars = [...text];
  if (!chars.every((c) => c.charCodeAt(0) <= 255)) return text;
  if (!chars.some((c) => c.charCodeAt(0) > 127)) return text;
  try {
    const bytes = Uint8Array.from(chars.map((c) => c.charCodeAt(0)));
    const decoded = new TextDecoder('gbk').decode(bytes);
    if (decoded.includes('\uFFFD')) return text;
    if (!/[\u4e00-\u9fff]/.test(decoded)) return text;
    return decoded;
  } catch {
    return text;
  }
}

/** Walk SVG markup and repair GBK-mojibake text nodes. */
export function repairSvgGbkMojibake(svg: string): string {
  return svg.replace(/>([^<>]+)</g, (full, text: string) => {
    // Skip pure whitespace between tags.
    if (!text.trim()) return full;
    return `>${repairGbkMojibakeText(text)}<`;
  });
}

function viewSizeFromMetafile(data: Uint8Array): { viewWidth: number; viewHeight: number } {
  const parsed = parseMetafile(data);
  const ph = parsed.header?.placeableHeader;
  if (ph && ph.inch > 0) {
    const w = Math.max(1, Math.round(((ph.right - ph.left) / ph.inch) * 96));
    const h = Math.max(1, Math.round(((ph.bottom - ph.top) / ph.inch) * 96));
    return { viewWidth: w, viewHeight: h };
  }
  const box = parsed.header?.frame ?? parsed.header?.bounds;
  if (box) {
    // EMF frame/bounds are in 0.01 mm units.
    const w = Math.max(1, Math.round(((box.right - box.left) / 2540) * 96));
    const h = Math.max(1, Math.round(((box.bottom - box.top) / 2540) * 96));
    if (w > 1 && h > 1) return { viewWidth: w, viewHeight: h };
  }
  return { viewWidth: 800, viewHeight: 200 };
}

function utf8ToBase64(text: string): string {
  // Prefer Buffer when available (Node / Electron main); fall back to btoa.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Buf = (globalThis as any).Buffer as
    | { from(data: string, enc: string): { toString(enc: string): string } }
    | undefined;
  if (Buf) return Buf.from(text, 'utf8').toString('base64');
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Convert WMF/EMF bytes to an `image/svg+xml` data URL for `<img src>`.
 * Returns null when the payload is not a metafile or conversion fails —
 * callers should keep the original data URL.
 */
export function metafileToSvgDataUrl(data: ArrayBuffer | Uint8Array): string | null {
  try {
    ensureWmfDbcsStringPatch();
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.byteLength < 8) return null;
    const fileType = detectFileType(bytes);
    if (fileType === 'unknown') return null;

    const size = viewSizeFromMetafile(bytes);
    let svg = renderToSvg(bytes, size);
    if (typeof svg !== 'string' || !svg.includes('<svg')) return null;
    // Belt-and-suspenders for any path that still emitted Latin-1 mojibake.
    svg = repairSvgGbkMojibake(svg);

    return `data:image/svg+xml;base64,${utf8ToBase64(svg)}`;
  } catch {
    return null;
  }
}

/**
 * If `mimeType`/`path` identify a metafile, return an SVG data URL for display.
 * Otherwise return null.
 */
export function displayDataUrlForMedia(
  data: ArrayBuffer,
  mimeType: string,
  path?: string
): string | null {
  if (!isMetafileMime(mimeType, path)) return null;
  return metafileToSvgDataUrl(data);
}
