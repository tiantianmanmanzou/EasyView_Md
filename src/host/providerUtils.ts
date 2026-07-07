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

/**
 * Repair markdown that was accidentally written as a serialized string.
 * This is intentionally narrow: normal markdown can contain examples with "\\n",
 * but a real document should not have dozens of escaped newlines and almost no
 * actual line breaks.
 */
export function repairSerializedMarkdownContent(content: string): string {
  const escapedNewlines = (content.match(/\\r\\n|\\n|\\r/g) || []).length;
  if (escapedNewlines < 10) return content;

  const realNewlines = (content.match(/\r\n|\n|\r/g) || []).length;
  if (realNewlines > Math.max(2, Math.floor(escapedNewlines / 20))) {
    return content;
  }

  const trimmed = content.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      const normalized = trimmed.startsWith("'")
        ? `"${trimmed.slice(1, -1).replace(/"/g, '\\"')}"`
        : trimmed;
      const parsed = JSON.parse(normalized);
      if (typeof parsed === 'string') {
        return parsed;
      }
    } catch {
      // Fall through to conservative unescape below.
    }
  }

  return content
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}
