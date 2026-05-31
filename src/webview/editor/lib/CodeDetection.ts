/**
 * Code node type checking utilities
 * Copied from Outline's shared/editor/lib/isCode.ts
 */

import type { Node } from "prosemirror-model";

export function isCode(node: Node) {
  return node.type.name === "code_block" || node.type.name === "code_fence";
}

export function isPlainTextLanguage(language: unknown): boolean {
  const normalized = String(language ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  return (
    normalized === '' ||
    normalized === 'none' ||
    normalized === 'plain' ||
    normalized === 'plaintext' ||
    normalized === 'text'
  );
}

/**
 * Returns true if the node is a code block with Mermaid language (supports both "mermaid" and "mermaidjs").
 *
 * @param node The node to check.
 * @returns true if the node is a Mermaid code block.
 */
export function isMermaid(node: Node) {
  return (
    isCode(node) &&
    (node.attrs.language === "mermaid" || node.attrs.language === "mermaidjs")
  );
}

export function isPlainTextCode(node: Node) {
  return isCode(node) && isPlainTextLanguage(node.attrs.language);
}

export function isPlantUml(node: Node) {
  return (
    isCode(node) &&
    (node.attrs.language === 'plantuml' || node.attrs.language === 'puml')
  );
}
