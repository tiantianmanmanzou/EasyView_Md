/**
 * Pure utility functions extracted from provider.ts for testability.
 */

/** Regex matching the settings comment at the start of the file */
export const SETTINGS_COMMENT_RE = /^<!--\s*fullWidth:\s*(true|false)(?:\s+tocVisible:\s*(true|false))?(?:\s+tableWrap:\s*(true|false))?(?:\s+lineNumbersVisible:\s*(true|false))?\s*-->[\r\n]*/;

export interface EditorSettings {
  fullWidth: boolean;
  tocVisible: boolean;
  tableWrap: boolean;
}

/**
 * Extract editor settings from markdown content.
 * Reads the legacy settings comment when present for backward compatibility.
 */
export function extractSettings(content: string): EditorSettings {
  const match = content.match(SETTINGS_COMMENT_RE);
  return {
    fullWidth: match ? match[1] === 'true' : true,
    tocVisible: match && match[2] ? match[2] === 'true' : true,
    tableWrap: match && match[3] ? match[3] === 'true' : false, // default: false
  };
}

/**
 * Compute minimal diff between two strings.
 * Returns the start index and end indices for both old and new strings.
 */
export function computeMinimalDiff(oldStr: string, newStr: string): { start: number; oldEnd: number; newEnd: number } {
  let start = 0;
  const minLen = Math.min(oldStr.length, newStr.length);

  // Find common prefix
  while (start < minLen && oldStr[start] === newStr[start]) {
    start++;
  }

  // Find common suffix
  let oldEnd = oldStr.length;
  let newEnd = newStr.length;
  while (oldEnd > start && newEnd > start && oldStr[oldEnd - 1] === newStr[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  return { start, oldEnd, newEnd };
}
