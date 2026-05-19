/**
 * PdfMermaidRenderer — Mermaid diagram collection and SVG-to-PNG conversion for PDF export.
 */

import type { Node as ProsemirrorNode } from 'prosemirror-model';
import { type PdfPalette } from './PdfPalette';

/**
 * Collect mermaid diagram sources from the document, then re-render them
 * with the appropriate theme for PDF export.
 */
export async function collectMermaidSvgs(doc: ProsemirrorNode, palette: PdfPalette): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const sources: string[] = [];

  // Collect all mermaid sources from the document
  doc.descendants((node) => {
    if (node.type.name === 'code_block') {
      const lang = node.attrs.language || '';
      if (lang === 'mermaid' || lang === 'mermaidjs') {
        const text = node.textContent?.trim();
        if (text) sources.push(text);
      }
    } else if (node.type.name === 'mermaid') {
      const text = (node.attrs.content || '').trim();
      if (text) sources.push(text);
    }
  });

  if (sources.length === 0) return map;

  // Re-render with appropriate theme for PDF (DOM SVGs inherit editor theme colors)
  try {
    const mermaidModule = await import('mermaid');
    const mermaid = mermaidModule.default;

    mermaid.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: palette.mermaidTheme as any,
      darkMode: palette.mermaidDarkMode,
      fontFamily: 'Arial, Helvetica, sans-serif',
    });

    for (const source of sources) {
      try {
        const tempId = 'pdf-mermaid-' + Math.random().toString(36).substr(2, 9);
        const tempEl = document.createElement('div');
        tempEl.id = tempId;
        tempEl.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
        document.body.appendChild(tempEl);
        const { svg } = await mermaid.render(tempId, source);
        map.set(source, svg);
        tempEl.remove();
      } catch {
        // skip individual diagram
      }
    }
  } catch {
    // mermaid import failed — fall back to DOM SVGs
    try {
      const wrappers = document.querySelectorAll('.mermaid-diagram-wrapper');
      for (const wrapper of wrappers) {
        const svgEl = wrapper.querySelector('svg');
        const pre = wrapper.previousElementSibling;
        if (svgEl && pre) {
          const code = pre.querySelector('code');
          const text = code?.textContent?.trim() || pre.textContent?.trim() || '';
          if (text && sources.includes(text) && !map.has(text)) {
            const svgString = new XMLSerializer().serializeToString(svgEl);
            map.set(text, svgString);
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return map;
}

// ─── Mermaid SVG -> PNG Conversion ────────────────────────────────────────

/**
 * Convert mermaid SVG strings to PNG base64 images via canvas.
 * This avoids pdfmake SVG rendering issues (dark theme colors, missing fonts, etc.).
 */
export async function convertMermaidSvgsToPng(
  svgMap: Map<string, string>,
  bgColor: string,
): Promise<Map<string, { base64: string; width: number; height: number }>> {
  const result = new Map<string, { base64: string; width: number; height: number }>();

  for (const [source, svgString] of svgMap) {
    try {
      const pngData = await svgToPng(svgString, bgColor);
      if (pngData) {
        result.set(source, pngData);
      }
    } catch {
      // skip — will fall back to SVG or code block
    }
  }

  return result;
}

/**
 * Convert an SVG string to a PNG base64 data URI via Image + Canvas.
 */
export function svgToPng(svgString: string, bgColor = '#ffffff'): Promise<{ base64: string; width: number; height: number } | null> {
  return new Promise((resolve) => {
    try {
      // Parse SVG to get dimensions
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(svgString, 'image/svg+xml');
      const svgEl = svgDoc.documentElement;

      // Get SVG dimensions
      let width = parseFloat(svgEl.getAttribute('width') || '0');
      let height = parseFloat(svgEl.getAttribute('height') || '0');

      // If no explicit dimensions, try viewBox
      if (!width || !height) {
        const viewBox = svgEl.getAttribute('viewBox');
        if (viewBox) {
          const parts = viewBox.split(/[\s,]+/);
          width = parseFloat(parts[2]) || 800;
          height = parseFloat(parts[3]) || 600;
        } else {
          width = 800;
          height = 600;
        }
      }

      // Ensure SVG has explicit dimensions and white background
      svgEl.setAttribute('width', String(width));
      svgEl.setAttribute('height', String(height));
      const existingStyle = svgEl.getAttribute('style') || '';
      svgEl.setAttribute('style', existingStyle + `;background:${bgColor};`);

      // Scale up for better quality (3x)
      const scale = 3;
      const canvasWidth = width * scale;
      const canvasHeight = height * scale;

      const serializer = new XMLSerializer();
      const svgData = serializer.serializeToString(svgEl);
      const svgBase64 = btoa(unescape(encodeURIComponent(svgData)));
      const dataUri = `data:image/svg+xml;base64,${svgBase64}`;

      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = canvasWidth;
          canvas.height = canvasHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) { resolve(null); return; }

          // Page background color
          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, canvasWidth, canvasHeight);

          // Draw SVG
          ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);

          const base64 = canvas.toDataURL('image/png');
          resolve({ base64, width, height });
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);

      // Timeout after 5 seconds
      setTimeout(() => resolve(null), 5000);

      img.src = dataUri;
    } catch {
      resolve(null);
    }
  });
}
