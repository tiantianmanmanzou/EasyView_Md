/**
 * Code block highlighting for HTML export.
 *
 * Highlights code blocks using Refractor and converts AST nodes to HTML.
 */

import refractor from 'refractor/core';
import { getRefractorLangForLanguage } from '../../../editor/lib/CodeLanguages';
import { escapeHtml } from './HtmlDomCleanup';

/**
 * Find all code blocks and replace their content with highlighted HTML.
 */
export function highlightCodeBlocks(container: HTMLElement): void {
  const preElements = container.querySelectorAll('pre');

  preElements.forEach((pre) => {
    const code = pre.querySelector('code');
    if (!code) return;

    const className = code.className || pre.className || '';
    const match = className.match(/language-(\S+)/);
    const language = match ? match[1] : '';

    // Skip mermaid blocks
    if (language === 'mermaid' || language === 'mermaidjs') return;

    if (!language) return;

    // Add language label in top-right corner
    const label = document.createElement('span');
    label.className = 'code-lang-label';
    label.textContent = language;
    pre.style.position = 'relative';
    pre.appendChild(label);

    const refractorLang = getRefractorLangForLanguage(language);
    if (!refractorLang || !refractor.registered(refractorLang)) return;

    const text = code.textContent || '';
    try {
      const nodes = refractor.highlight(text, refractorLang);
      code.innerHTML = refractorNodesToHtml(nodes);
    } catch (err) {
      console.warn(`Failed to highlight ${language}:`, err);
    }
  });
}

/**
 * Convert Refractor AST nodes to an HTML string.
 */
function refractorNodesToHtml(nodes: refractor.RefractorNode[]): string {
  return nodes.map((node) => {
    if (node.type === 'text') {
      return escapeHtml(node.value);
    }
    if (node.type === 'element') {
      const classes = (node.properties.className || []).join(' ');
      const inner = refractorNodesToHtml(node.children);
      return `<span class="${escapeHtml(classes)}">${inner}</span>`;
    }
    return '';
  }).join('');
}
