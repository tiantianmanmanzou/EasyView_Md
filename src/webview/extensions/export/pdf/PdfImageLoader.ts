/**
 * PdfImageLoader — loads all images in a ProseMirror document as base64 for PDF embedding.
 */

import type { Node as ProsemirrorNode } from 'prosemirror-model';

/**
 * Callback type for loading images from the extension host.
 * Given an originalSrc (local file path), returns a data URI or null.
 */
export type LoadFromHostFn = (originalSrc: string) => Promise<string | null>;

/**
 * Walk the document and collect all unique image sources.
 * Returns a Map of src → originalSrc (or empty string if no originalSrc).
 */
function collectImageSrcs(doc: ProsemirrorNode): Map<string, string> {
  const srcs = new Map<string, string>();
  doc.descendants((node) => {
    if (node.type.name === 'image') {
      const src = node.attrs.src || '';
      const originalSrc = node.attrs.originalSrc || '';
      if (src && !srcs.has(src)) {
        srcs.set(src, originalSrc);
      }
    }
  });
  return srcs;
}

/**
 * Convert an image URL to base64 data URI.
 * Tries multiple strategies in order.
 */
async function loadImageAsBase64(src: string): Promise<string | null> {
  // Already a data URI
  if (src.startsWith('data:')) {
    return src;
  }

  // For external URLs: fetch raw bytes first (preserves original format, no canvas conversion).
  // Canvas-based methods (DOM, CORS image) convert everything to PNG via toDataURL which
  // can corrupt JPEG color data (green rectangles) or fail on CORS-restricted images.
  if (src.startsWith('http://') || src.startsWith('https://')) {
    const fetchResult = await tryLoadViaFetch(src);
    if (fetchResult) return fetchResult;

    const corsResult = await tryLoadViaCorsImage(src);
    if (corsResult) return corsResult;
  }

  // DOM canvas — works for webview-proxied images and local files
  const domResult = await tryLoadFromDom(src);
  if (domResult) return domResult;

  return null;
}

/**
 * Find an <img> in the DOM with the matching src and convert via canvas.
 */
async function tryLoadFromDom(src: string): Promise<string | null> {
  try {
    const imgs = document.querySelectorAll('img');
    for (const img of imgs) {
      if (img.src === src || img.getAttribute('src') === src) {
        if (img.complete && img.naturalWidth > 0) {
          return imgToBase64(img);
        }
        // Wait for load
        return new Promise<string | null>((resolve) => {
          const timeout = setTimeout(() => resolve(null), 5000);
          img.onload = () => {
            clearTimeout(timeout);
            resolve(imgToBase64(img));
          };
          img.onerror = () => {
            clearTimeout(timeout);
            resolve(null);
          };
        });
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Load an external image by creating a new <img> with crossOrigin="anonymous".
 * This avoids tainting the canvas (if server supports CORS).
 */
function tryLoadViaCorsImage(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(null); return; }
          ctx.drawImage(img, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 10000);
      img.src = src;
    } catch {
      resolve(null);
    }
  });
}

/**
 * Convert an HTMLImageElement to base64 via canvas.
 */
function imgToBase64(img: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png');
  } catch {
    return null; // CORS or tainted canvas
  }
}

/**
 * Fetch an image and convert to base64.
 */
async function tryLoadViaFetch(src: string): Promise<string | null> {
  try {
    const resp = await fetch(src);
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') || '';
    const blob = await resp.blob();
    // Require at least one source to confirm this is an image
    const isImage = ct.startsWith('image/') || blob.type.startsWith('image/');
    if (!isImage) return null;
    const dataUri = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
    // Validate the data URI starts with data:image/
    if (dataUri && dataUri.startsWith('data:image/')) return dataUri;
    return null;
  } catch {
    return null;
  }
}

/** 1x1 fully transparent pixel (RGBA 0,0,0,0) as fallback for missing images */
const FALLBACK_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';

/** MIME types supported by pdfmake (image/jpg is a common alias for image/jpeg) */
const PDFMAKE_SUPPORTED = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml'];

/**
 * Convert a data URI to a pdfmake-compatible format (PNG) via canvas.
 * Needed for BMP, WebP, GIF, TIFF and other formats pdfmake can't handle.
 */
function convertToPng(dataUri: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(null); return; }
          ctx.drawImage(img, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      setTimeout(() => resolve(null), 10000);
      img.src = dataUri;
    } catch {
      resolve(null);
    }
  });
}

/**
 * Load all images in the document and return a Map of src → base64 data URI.
 * Uses DOM canvas first, then CORS image, then fetch, then extension host for local files.
 */
export async function loadAllImages(
  doc: ProsemirrorNode,
  loadFromHost?: LoadFromHostFn,
): Promise<Map<string, string>> {
  const srcs = collectImageSrcs(doc);
  const result = new Map<string, string>();

  const promises = Array.from(srcs.entries()).map(async ([src, originalSrc]) => {
    // Strategies 1-3: DOM canvas, CORS image, fetch
    let base64 = await loadImageAsBase64(src);

    // Strategy 4: Ask extension host (Node.js side — no CORS restrictions)
    // Works for local file paths AND http/https URLs that failed browser-based loading
    if (!base64 && loadFromHost) {
      const pathToLoad = originalSrc || src;
      if (pathToLoad) {
        base64 = await loadFromHost(pathToLoad);
      }
    }

    // Validate: only accept data URIs with image MIME type
    if (base64 && !base64.startsWith('data:image/')) {
      console.warn('[InLineMd] Image has invalid data URI format, discarding:', src.substring(0, 60));
      base64 = null;
    }

    // Convert unsupported formats (BMP, WebP, GIF, TIFF, etc.) to PNG for pdfmake
    if (base64) {
      const mime = base64.substring(5, base64.indexOf(';'));
      if (!PDFMAKE_SUPPORTED.includes(mime)) {
        const converted = await convertToPng(base64);
        base64 = converted || null;
      }
    }

    if (!base64) {
      console.warn('[InLineMd] Image NOT loaded:', src.substring(0, 60), '← originalSrc:', originalSrc || '(none)');
    }
    result.set(src, base64 || FALLBACK_IMAGE);
  });

  await Promise.all(promises);
  return result;
}
