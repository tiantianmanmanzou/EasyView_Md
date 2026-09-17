/**
 * Heading to Slug
 *
 * Generates URL-safe slugs from heading text for anchor links.
 * Supports Unicode (Cyrillic, CJK, etc.) via \p{L} regex.
 * Adapted from Outline's headingToSlug.
 */

import type { Node } from 'prosemirror-model';

const cache = new Map<string, string>();

/**
 * Generate a safe slug from text.
 * Prefixed with "h-" to avoid IDs starting with numbers or special chars
 * (querySelector doesn't like IDs starting with digits).
 */
function safeSlugify(text: string): string {
  if (cache.has(text)) {
    return cache.get(text)!;
  }

  let slug = 'h-' + text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '') // Keep letters (incl. Cyrillic), digits, spaces, hyphens
    .replace(/\s+/g, '-')              // Spaces -> hyphens
    .replace(/-+/g, '-')               // Collapse multiple hyphens
    .replace(/^-|-$/g, '');            // Trim leading/trailing hyphens

  if (!slug || slug === 'h-') {
    slug = 'h-heading';
  }

  cache.set(text, slug);
  return slug;
}

/**
 * Generate a unique slug for a heading node.
 *
 * @param node - ProseMirror heading node
 * @param index - Duplicate index (0 = first occurrence, 1+ = duplicates)
 */
export default function headingToSlug(node: Node, index = 0): string {
  const slugified = safeSlugify(node.textContent);
  if (index === 0) {
    return slugified;
  }
  return `${slugified}-${index}`;
}
