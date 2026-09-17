/**
 * PdfMathRenderer — KaTeX math expression rendering to PNG images for PDF export.
 */

import type { Node as ProsemirrorNode } from 'prosemirror-model';
import katex from 'katex';

/**
 * Collect all math expressions from the document and render them as base64 PNG images.
 * Uses KaTeX to render TeX -> HTML, then captures via SVG foreignObject + canvas.
 */
export async function collectMathImages(doc: ProsemirrorNode, textColor: string): Promise<Map<string, { base64: string; width: number; height: number }>> {
  const map = new Map<string, { base64: string; width: number; height: number }>();

  // Collect all unique TeX expressions
  const texItems: Array<{ tex: string; isBlock: boolean }> = [];
  const seen = new Set<string>();

  doc.descendants((node) => {
    if (node.type.name === 'math_block') {
      const tex = node.textContent?.trim();
      if (tex && !seen.has(tex)) {
        seen.add(tex);
        texItems.push({ tex, isBlock: true });
      }
    } else if (node.type.name === 'math_inline') {
      const tex = node.textContent?.trim();
      if (tex && !seen.has(tex)) {
        seen.add(tex);
        texItems.push({ tex, isBlock: false });
      }
    }
  });

  if (texItems.length === 0) return map;

  // Resolve katex — static import (dynamic import fails in esbuild IIFE)
  const katexLib = (katex as any).default || katex;
  if (!katexLib || !katexLib.renderToString) {
    console.warn('[InLineMd] KaTeX not available for math rendering');
    return map;
  }

  // Collect KaTeX CSS (layout rules only, skip @font-face — CSP blocks font fetches)
  const katexCss = collectKatexCss();

  const t0 = performance.now();
  for (const { tex, isBlock } of texItems) {
    try {
      const result = await renderMathToImage(katexLib, tex, isBlock, katexCss, textColor);
      if (result) {
        map.set(tex, result);
      }
    } catch {
      // skip failed math expressions
    }
  }
  console.log(`[InLineMd PDF] math render (${texItems.length} items): ${(performance.now() - t0).toFixed(0)}ms`);

  return map;
}

/**
 * Collect KaTeX CSS rules from the page's stylesheets.
 * Skips @font-face rules — CSP blocks font fetches in VS Code webview,
 * and fonts can't be loaded inside SVG foreignObject anyway.
 * KaTeX will fall back to system serif/sans-serif fonts which is acceptable for PDF.
 */
export function collectKatexCss(): string {
  const allRules: string[] = [];

  try {
    for (const sheet of document.styleSheets) {
      try {
        let isKatex = false;
        for (const rule of sheet.cssRules) {
          if (rule.cssText.includes('KaTeX_Main') || rule.cssText.includes('.katex')) {
            isKatex = true;
            break;
          }
        }
        if (!isKatex) continue;

        for (const rule of sheet.cssRules) {
          // Skip @font-face — CSP blocks font URL fetches
          if (rule.cssText.startsWith('@font-face')) continue;
          allRules.push(rule.cssText);
        }
      } catch {
        // CORS restriction — skip
      }
    }
  } catch {
    // ignore
  }

  // Add fallback font-family mappings so KaTeX classes still get reasonable fonts
  // color: inherit ensures KaTeX uses the wrapper's text color (important for dark theme PDFs)
  allRules.push('.katex { font-family: "Times New Roman", Times, serif; color: inherit !important; }');
  allRules.push('.katex .mathit { font-family: "Times New Roman", Times, serif; font-style: italic; }');
  allRules.push('.katex .mathrm { font-family: "Times New Roman", Times, serif; }');
  allRules.push('.katex .mathbf { font-family: "Times New Roman", Times, serif; font-weight: bold; }');
  allRules.push('.katex .mathsf { font-family: Arial, Helvetica, sans-serif; }');
  allRules.push('.katex .mathtt { font-family: "Courier New", Courier, monospace; }');

  return allRules.join('\n');
}

/**
 * Render a single TeX expression to a base64 PNG image.
 * Uses KaTeX to produce HTML, measures it in a hidden DOM element,
 * wraps in SVG foreignObject with inlined CSS, renders to canvas via data URI.
 */
export async function renderMathToImage(
  katexLib: any,
  tex: string,
  isBlock: boolean,
  katexCss: string,
  textColor: string,
): Promise<{ base64: string; width: number; height: number } | null> {
  // Render TeX to HTML
  let html: string;
  try {
    html = katexLib.renderToString(tex, {
      displayMode: isBlock,
      throwOnError: false,
      output: 'html',
    });
  } catch {
    return null;
  }

  // Create hidden container to measure the rendered output
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden;';
  container.style.background = 'transparent';
  container.style.color = textColor;
  container.style.padding = '4px 8px';
  container.style.fontSize = '11px';
  if (isBlock) container.style.textAlign = 'center';
  else container.style.display = 'inline-block';
  container.innerHTML = html;
  document.body.appendChild(container);

  // Wait for layout (single frame is enough since styles are inline)
  await new Promise<void>(r => requestAnimationFrame(() => r()));

  const rect = container.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);

  if (width <= 0 || height <= 0) {
    container.remove();
    return null;
  }

  // Create a clean wrapper (without hidden styles) for XHTML serialization
  const wrapper = document.createElement('div');
  wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrapper.style.cssText = `background:transparent;color:${textColor};padding:4px 8px;font-size:11px;${isBlock ? 'text-align:center;' : 'display:inline-block;'}`;
  // Move children to clean wrapper
  while (container.firstChild) {
    wrapper.appendChild(container.firstChild);
  }
  container.remove();

  // XMLSerializer produces XHTML-compatible output (required inside SVG foreignObject)
  const serializer = new XMLSerializer();
  const xhtml = serializer.serializeToString(wrapper);

  // Build SVG with foreignObject
  const scale = 4; // high quality for PDF (inline math gets scaled up)
  const svgWidth = width * scale;
  const svgHeight = height * scale;

  const svgXml = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">`,
    `<foreignObject x="0" y="0" width="100%" height="100%">`,
    `<div xmlns="http://www.w3.org/1999/xhtml" style="transform:scale(${scale});transform-origin:0 0;width:${width}px;height:${height}px;">`,
    `<style><![CDATA[${katexCss}]]></style>`,
    xhtml,
    `</div></foreignObject></svg>`,
  ].join('');

  // Convert SVG -> data URI -> Image -> Canvas -> base64 PNG
  // Use data URI instead of blob URL to avoid CSP img-src restrictions
  const svgBase64 = btoa(unescape(encodeURIComponent(svgXml)));
  const dataUri = `data:image/svg+xml;base64,${svgBase64}`;

  try {
    const img = await loadImageFromUrl(dataUri);
    const canvas = document.createElement('canvas');
    canvas.width = svgWidth;
    canvas.height = svgHeight;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return null;

    ctx2d.drawImage(img, 0, 0, svgWidth, svgHeight);

    const base64 = canvas.toDataURL('image/png');
    return { base64, width, height };
  } catch {
    return null;
  }
}

function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = url;
  });
}
