/**
 * PdfCodeHighlighting — Syntax highlighting for code blocks in PDF export.
 */

import refractor from 'refractor/core';
import { getRefractorLangForLanguage, getLoaderForLanguage } from '../../../editor/lib/CodeLanguages';
import { type PdfPalette } from './PdfPalette';

/**
 * Highlight code using refractor (same library as the editor).
 * Returns colored segments for a given code text and language.
 * No DOM dependency — works directly with the AST.
 */
export async function highlightCode(text: string, language: string, palette: PdfPalette): Promise<Array<{ text: string; color?: string }> | null> {
  try {
    const lang = getRefractorLangForLanguage(language);
    if (!lang) return null;

    // Load language if not registered
    if (!refractor.registered(lang)) {
      const loader = getLoaderForLanguage(language);
      if (loader) {
        const syntax = await loader();
        refractor.register(syntax);
      }
    }

    if (!refractor.registered(lang)) return null;

    const ast = refractor.highlight(text, lang);
    const segments: Array<{ text: string; color?: string }> = [];

    function walkAst(nodes: any, inheritedClasses: string[] = []) {
      if (!nodes || !Array.isArray(nodes)) return;
      for (const node of nodes) {
        if (!node) continue;
        if (node.type === 'text') {
          const color = classesToColor(inheritedClasses, palette);
          segments.push({ text: node.value, color });
        } else if (node.type === 'element') {
          const cn = node.properties?.className;
          const classes = [...inheritedClasses, ...(Array.isArray(cn) ? cn : [])];
          walkAst(node.children, classes);
        }
      }
    }

    const children = ast?.children ?? ast;
    walkAst(Array.isArray(children) ? children : []);
    return segments.length > 0 ? segments : null;
  } catch (err) {
    console.warn('[InLineMd] highlightCode failed for', language, ':', err);
    return null;
  }
}

/** Map refractor CSS classes to theme colors */
export function classesToColor(classes: string[], palette: PdfPalette): string | undefined {
  for (const cls of classes) {
    if (cls !== 'token' && palette.prismColors[cls]) {
      return palette.prismColors[cls];
    }
  }
  return undefined;
}
