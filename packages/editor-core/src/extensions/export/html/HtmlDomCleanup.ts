/**
 * DOM cleanup and image processing for HTML export.
 *
 * Removes editor artifacts, collects image references, and provides
 * filename sanitization utilities.
 */

import { extractImageFilename, makeUniqueFilename } from './ExportTypes';
import type { ExportImage } from './ExportTypes';

// Preserve the existing helper exports while keeping their implementation in
// the dependency-free ExportTypes module.
export {
  escapeHtml,
  extractImageFilename,
  makeUniqueFilename,
  sanitizeFilename,
} from './ExportTypes';

/**
 * Clean up editor-specific artifacts from the DOM.
 * Returns array of images found in the document for export.
 */
export function cleanupDom(container: HTMLElement): ExportImage[] {
  // Remove contenteditable attributes
  container.querySelectorAll('[contenteditable]').forEach((el) => {
    el.removeAttribute('contenteditable');
  });

  // Remove spellcheck attributes
  container.querySelectorAll('[spellcheck]').forEach((el) => {
    el.removeAttribute('spellcheck');
  });

  // Remove editor-specific classes
  container.querySelectorAll('.ProseMirror').forEach((el) => {
    el.classList.remove('ProseMirror');
  });

  // Collect images and rewrite src to images/ folder
  const images: ExportImage[] = [];
  const usedFilenames = new Set<string>();
  // Track already-processed originalSrc to dedup same image used multiple times
  const srcToFilename = new Map<string, string>();

  container.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    const originalSrc = img.getAttribute('data-original-src');
    const effectiveSrc = originalSrc || src;

    // Remove editor internal attribute
    img.removeAttribute('data-original-src');

    // Skip data: URIs (already embedded)
    if (effectiveSrc.startsWith('data:')) return;

    // Skip empty src
    if (!effectiveSrc) return;

    const isExternal = effectiveSrc.startsWith('http://') || effectiveSrc.startsWith('https://');

    // Skip webview-internal URIs that have no originalSrc
    if (!isExternal && !originalSrc && (src.startsWith('vscode-webview://') || src.startsWith('https://file+'))) {
      img.style.display = 'none';
      img.setAttribute('alt', img.getAttribute('alt') || '[Local image]');
      img.setAttribute('src', '');
      return;
    }

    // Dedup: if same originalSrc was already processed, reuse filename
    const existing = srcToFilename.get(effectiveSrc);
    if (existing) {
      img.setAttribute('src', 'images/' + existing);
      return;
    }

    // Extract and uniquify filename
    let filename = extractImageFilename(effectiveSrc);
    filename = makeUniqueFilename(filename, usedFilenames);
    usedFilenames.add(filename);
    srcToFilename.set(effectiveSrc, filename);

    // Set path in HTML
    img.setAttribute('src', 'images/' + filename);

    images.push({ originalSrc: effectiveSrc, exportFilename: filename, isExternal });
  });

  // Remove heading-content class (editor artifact)
  container.querySelectorAll('.heading-content').forEach((el) => {
    el.removeAttribute('class');
  });

  // Remove dir="auto" from headings
  container.querySelectorAll('[dir="auto"]').forEach((el) => {
    el.removeAttribute('dir');
  });

  // Clean up drawio blocks — just remove them or show placeholder
  container.querySelectorAll('div[data-type="drawio"]').forEach((el) => {
    const placeholder = document.createElement('p');
    placeholder.textContent = '[Draw.io diagram — not available in export]';
    placeholder.style.color = 'var(--text-tertiary)';
    placeholder.style.fontStyle = 'italic';
    el.replaceWith(placeholder);
  });

  return images;
}
