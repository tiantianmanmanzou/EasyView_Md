/**
 * ToolbarMarkdownInterpreter — "Interpret as Markdown" helpers for the floating toolbar.
 */

import { EditorState } from 'prosemirror-state';
import type { Node as ProsemirrorNode } from 'prosemirror-model';
import { schema } from '../../../editor/EditorSchema';
import { createPasteParser } from '../../../editor/lib/MarkdownParser';

/** Regex for markdown patterns that could be reinterpreted as rich formatting */
export const MD_PATTERN = /(\*\*|__|~~|==|`[^`]+`|\[.+?\]\(.+?\)|^#{1,6}\s|^>\s|^[-*+]\s|^\d+\.\s|^```|^---)/m;

/**
 * Collect all paragraph nodes that are (partially) inside the selection.
 * Returns them in document order.
 */
function collectSelectedParagraphs(state: EditorState): { node: ProsemirrorNode; pos: number }[] {
  const { from, to } = state.selection;
  const result: { node: ProsemirrorNode; pos: number }[] = [];

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === schema.nodes.paragraph) {
      result.push({ node, pos });
      return false; // don't descend into paragraph children
    }
  });

  return result;
}

/**
 * Extract markdown-like text from a paragraph node.
 * Preserves marks (bold, italic, etc.) by wrapping with markdown syntax,
 * and converts hard_break nodes to newlines.
 */
function paragraphToText(node: ProsemirrorNode): string {
  let text = '';
  node.forEach((child) => {
    if (child.type.name === 'hard_break') {
      text += '\n';
    } else {
      let t = child.isText ? (child.text || '') : child.textContent;
      // Preserve marks by wrapping with markdown syntax
      for (const mark of child.marks) {
        switch (mark.type.name) {
          case 'strong': t = `**${t}**`; break;
          case 'em': t = `*${t}*`; break;
          case 'strikethrough': t = `~~${t}~~`; break;
          case 'highlight': t = `==${t}==`; break;
          case 'code_inline': t = `\`${t}\``; break;
          case 'link': t = `[${t}](${mark.attrs.href})`; break;
        }
      }
      text += t;
    }
  });
  return text;
}

/** Check if selected paragraphs contain markdown-significant patterns */
export function hasMarkdownPatterns(state: EditorState): boolean {
  const paragraphs = collectSelectedParagraphs(state);
  if (paragraphs.length === 0) return false;

  for (const { node } of paragraphs) {
    const text = paragraphToText(node);
    if (text.trim() && MD_PATTERN.test(text)) return true;
  }
  return false;
}

/** Lazily cached paste parser instance */
let pasteParserInstance: ReturnType<typeof createPasteParser> | null = null;
export function getPasteParser() {
  if (!pasteParserInstance) pasteParserInstance = createPasteParser();
  return pasteParserInstance;
}

/**
 * Re-parse selected paragraphs as markdown and replace them.
 * Supports single and multi-paragraph selections.
 */
export function interpretAsMarkdown(state: EditorState, dispatch?: any): boolean {
  const paragraphs = collectSelectedParagraphs(state);
  if (paragraphs.length === 0) return false;

  // Build combined markdown text from all selected paragraphs
  const lines: string[] = [];
  for (const { node } of paragraphs) {
    const text = paragraphToText(node);
    if (text.trim()) lines.push(text);
  }

  const combined = lines.join('\n');
  if (!combined.trim()) return false;

  const parsed = getPasteParser().parse(combined);
  if (!parsed || parsed.content.size === 0) return false;

  // Check if result is identical to the original (no meaningful change)
  if (
    parsed.childCount === paragraphs.length &&
    paragraphs.every(({ node }, i) => {
      const child = parsed.child(i);
      return (
        child.type === schema.nodes.paragraph &&
        child.textContent === node.textContent &&
        child.childCount === 1 &&
        child.firstChild?.marks.length === 0
      );
    })
  ) {
    return false;
  }

  if (dispatch) {
    // Calculate the range covering all selected paragraphs
    const firstPos = paragraphs[0].pos;
    const lastPara = paragraphs[paragraphs.length - 1];
    const lastEnd = lastPara.pos + lastPara.node.nodeSize;

    const tr = state.tr.replaceWith(firstPos, lastEnd, parsed.content);
    dispatch(tr.scrollIntoView());
  }
  return true;
}
