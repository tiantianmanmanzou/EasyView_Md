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
  const language = normalizeDiagramLanguage(node.attrs.language);
  return (
    isCode(node) &&
    (language === "mermaid" || language === "mermaidjs")
  );
}

export function isPlainTextCode(node: Node) {
  return isCode(node) && isPlainTextLanguage(node.attrs.language);
}

export function isPlantUml(node: Node) {
  const language = normalizeDiagramLanguage(node.attrs.language);
  return (
    isCode(node) &&
    (language === 'plantuml' || language === 'puml')
  );
}

function normalizeDiagramLanguage(language: unknown): string {
  return String(language ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function getExternalDiagramType(node: Node): 'graphviz' | 'd2' | 'bpmn' | null {
  if (!isCode(node)) return null;

  const language = normalizeDiagramLanguage(node.attrs.language);
  if (language === 'dot' || language === 'graphviz') return 'graphviz';
  if (language === 'd2') return 'd2';
  if (language === 'bpmn') return 'bpmn';
  if (language === 'xml' && isBpmnXml(node.textContent)) return 'bpmn';
  return null;
}

export function isBpmnXml(source: string): boolean {
  return /<(?:\w+:)?definitions\b/i.test(source) &&
    /xmlns(?::\w+)?=["']http:\/\/www\.omg\.org\/spec\/BPMN\/20100524\/MODEL["']/i.test(source);
}
