/**
 * Shared types and low-level helpers for HTML export.
 *
 * This module intentionally has no dependency on the HTML export entry point.
 * Keep it free of DOM, editor, and host imports so cleanup and highlighting
 * can depend on these primitives without creating an import cycle.
 */

export interface ExportImage {
  originalSrc: string;
  exportFilename: string;
  isExternal: boolean;
}

export interface ExportResult {
  html: string;
  images: ExportImage[];
}

/**
 * Extract a filename from a URL or file path.
 */
export function extractImageFilename(src: string): string {
  try {
    if (src.startsWith('http://') || src.startsWith('https://')) {
      const url = new URL(src);
      const pathname = url.pathname;
      const segments = pathname.split('/').filter(Boolean);
      if (segments.length > 0) {
        const last = decodeURIComponent(segments[segments.length - 1]);
        if (last && /\.\w+$/.test(last)) return sanitizeFilename(last);
      }
    }
  } catch {
    // Fall through to local path handling.
  }

  // Decode URL-encoded path first (e.g. C:%5CUsers%5C... → C:\Users\...)
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    // Use the original value when it is not valid URL-encoded text.
  }

  // Local path: split by / or \ and take the last segment.
  const segments = decoded.split(/[/\\]/).filter(Boolean);
  if (segments.length > 0) {
    const last = segments[segments.length - 1];
    // Remove query params if any.
    const clean = last.split('?')[0].split('#')[0];
    if (clean && /\.\w+$/.test(clean)) {
      return sanitizeFilename(clean);
    }
  }

  return 'image.png';
}

/**
 * Sanitize a filename: remove unsafe characters and limit its length.
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 200);
}

/**
 * Make a filename unique within a set.
 * "photo.png" → "photo-1.png" → "photo-2.png" etc.
 */
export function makeUniqueFilename(filename: string, used: Set<string>): string {
  if (!used.has(filename)) return filename;

  const dotIdx = filename.lastIndexOf('.');
  const base = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
  const ext = dotIdx > 0 ? filename.slice(dotIdx) : '';

  let counter = 1;
  let candidate: string;
  do {
    candidate = `${base}-${counter}${ext}`;
    counter++;
  } while (used.has(candidate));

  return candidate;
}

/**
 * Escape HTML special characters.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
