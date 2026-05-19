/**
 * YAML Frontmatter Utilities
 *
 * Parses and serializes YAML frontmatter in markdown files.
 * Uses gray-matter for parsing and js-yaml for serialization.
 */

import matter from 'gray-matter';
import yaml from 'js-yaml';

export interface FrontmatterData {
  [key: string]: any;
}

export interface ParsedMarkdown {
  frontmatter: FrontmatterData | null;
  rawYaml: string;
  content: string;
  hasFrontmatter: boolean;
}

/**
 * Parses markdown with YAML frontmatter
 *
 * @example
 * ```
 * ---
 * title: My Document
 * date: 2026-02-05
 * ---
 * # Content
 * ```
 */
export function parseMarkdownWithFrontmatter(markdown: string): ParsedMarkdown {
  // Strip BOM if present (VS Code may include it for some encodings)
  if (markdown.charCodeAt(0) === 0xFEFF) {
    markdown = markdown.slice(1);
  }

  try {
    const parsed = matter(markdown);

    // gray-matter caches results and may return empty `matter` on repeated calls
    // for the same input. Extract rawYaml via regex when this happens.
    let rawYaml = parsed.matter || '';
    const hasFrontmatter = Object.keys(parsed.data).length > 0;
    if (!rawYaml && hasFrontmatter) {
      const fmMatch = markdown.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (fmMatch) rawYaml = fmMatch[1];
    }

    return {
      frontmatter: parsed.data,
      rawYaml,
      content: parsed.content,
      hasFrontmatter,
    };
  } catch {
    // gray-matter failed (non-standard YAML like backslash continuations)
    // Manually extract raw YAML between --- delimiters
    const fmMatch = markdown.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (fmMatch) {
      const rawYaml = fmMatch[1];
      const content = markdown.slice(fmMatch[0].length);
      return {
        frontmatter: null,
        rawYaml,
        content,
        hasFrontmatter: true,
      };
    }
    return {
      frontmatter: null,
      rawYaml: '',
      content: markdown,
      hasFrontmatter: false,
    };
  }
}

/**
 * Serializes frontmatter data back to YAML string
 *
 * @param data - Frontmatter object
 * @returns YAML string with delimiters (---\n...\n---)
 */
export function serializeFrontmatter(data: FrontmatterData): string {
  if (!data || Object.keys(data).length === 0) {
    return '';
  }

  try {
    const yamlString = yaml.dump(data, {
      indent: 2,
      lineWidth: -1,      // Don't wrap long lines
      noRefs: true,       // Don't use YAML references (&, *)
      sortKeys: false,    // Preserve key order
      quotingType: '"',   // Use double quotes
      forceQuotes: false, // Only quote when necessary
    });

    return `---\n${yamlString}---\n`;
  } catch (error) {
    console.error('[Frontmatter] Failed to serialize:', error);
    return '';
  }
}

/**
 * Safely parses YAML string
 *
 * @param text - YAML string (without delimiters)
 * @returns Parsed object or empty object on error
 */
export function tryParseYAML(text: string): FrontmatterData {
  try {
    const parsed = yaml.load(text);
    return parsed as FrontmatterData;
  } catch (error) {
    console.error('[Frontmatter] Invalid YAML:', error);
    return {};
  }
}

/**
 * Validates YAML syntax
 *
 * @param text - YAML string to validate
 * @returns Error message or null if valid
 */
export function validateYAML(text: string): string | null {
  try {
    yaml.load(text);
    return null;
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
    return 'Invalid YAML syntax';
  }
}

/**
 * Formats YAML for display
 *
 * @param data - Frontmatter object
 * @returns Formatted YAML string (without delimiters)
 */
export function formatYAML(data: FrontmatterData): string {
  try {
    return yaml.dump(data, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });
  } catch (error) {
    return '';
  }
}
