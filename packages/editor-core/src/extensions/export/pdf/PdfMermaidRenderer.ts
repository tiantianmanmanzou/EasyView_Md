/**
 * PdfMermaidRenderer — Mermaid diagram collection and SVG-to-PNG conversion for PDF/DOCX export.
 */

import type { Node as ProsemirrorNode } from 'prosemirror-model';
import { type PdfPalette } from './PdfPalette';
import {
  looksLikeMermaid,
  normalizeMermaidSource,
} from './mermaidSource';

export {
  extractMermaidSourcesFromMarkdown,
  looksLikeMermaid,
  normalizeMermaidSource,
} from './mermaidSource';

export type MermaidPng = { base64: string; width: number; height: number };

function uniqueSources(sources: string[]): string[] {
  return [...new Set(sources.map(normalizeMermaidSource).filter(Boolean))];
}

function collectMermaidSourcesFromDoc(doc: ProsemirrorNode): string[] {
  const sources: string[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'code_block') {
      const lang = String(node.attrs.language || '').trim().toLowerCase();
      const text = normalizeMermaidSource(node.textContent || '');
      if (!text) return;
      if (lang === 'mermaid' || lang === 'mermaidjs' || looksLikeMermaid(text)) {
        sources.push(text);
      }
    } else if (node.type.name === 'mermaid') {
      const text = normalizeMermaidSource(node.attrs.content || '');
      if (text) sources.push(text);
    }
  });
  return sources;
}

function collectLiveMermaidSvgs(): Array<{ source: string; svg: string }> {
  const result: Array<{ source: string; svg: string }> = [];
  try {
    const wrappers = document.querySelectorAll('.mermaid-diagram-wrapper');
    for (const wrapper of wrappers) {
      const svgEl = wrapper.querySelector('svg');
      if (!svgEl) continue;
      const pre = wrapper.previousElementSibling;
      const code = pre?.querySelector?.('code');
      const source = normalizeMermaidSource(code?.textContent || pre?.textContent || '');
      const svg = new XMLSerializer().serializeToString(svgEl);
      if (svg) result.push({ source, svg });
    }
  } catch (error) {
    console.warn('[EasyView_Md PDF] Unable to read editor Mermaid SVG:', error);
  }
  return result;
}

/**
 * Collect mermaid diagram sources from the document, then re-render them
 * with the appropriate theme for PDF export.
 */
export async function collectMermaidPngsFromDoc(
  doc: ProsemirrorNode,
  palette: PdfPalette,
): Promise<Map<string, MermaidPng>> {
  const { map } = await collectExportMermaidPngs(collectMermaidSourcesFromDoc(doc), palette);
  return map;
}

export async function renderMermaidPngs(sources: string[], palette: PdfPalette): Promise<Map<string, MermaidPng>> {
  const { map } = await collectExportMermaidPngs(sources, palette);
  return map;
}

export async function collectExportMermaidPngs(
  sources: string[],
  palette: PdfPalette,
): Promise<{ map: Map<string, MermaidPng>; ordered: Array<{ source: string } & MermaidPng> }> {
  const unique = uniqueSources(sources);
  const svgMap = await renderMermaidSvgs(unique, palette);
  const live = collectLiveMermaidSvgs();
  const usedLive = new Set<number>();
  const ordered: Array<{ source: string } & MermaidPng> = [];
  const map = new Map<string, MermaidPng>();

  const takeLiveSvg = (source: string, index: number): string | undefined => {
    const key = normalizeMermaidSource(source);
    const bySource = live.findIndex((item, itemIndex) => !usedLive.has(itemIndex) && item.source && item.source === key);
    if (bySource >= 0) {
      usedLive.add(bySource);
      return live[bySource].svg;
    }
    if (!usedLive.has(index) && live[index]?.svg) {
      usedLive.add(index);
      return live[index].svg;
    }
    const next = live.findIndex((_item, itemIndex) => !usedLive.has(itemIndex));
    if (next >= 0) {
      usedLive.add(next);
      return live[next].svg;
    }
    return undefined;
  };

  const candidates = unique.length > 0 ? unique : live.map((item) => item.source);
  for (let index = 0; index < candidates.length; index++) {
    const source = candidates[index];
    let svg = svgMap.get(source);
    let png = svg ? await svgToPng(svg, palette.pageBackground) : null;
    if (!png) {
      svg = takeLiveSvg(source, index);
      png = svg ? await svgToPng(svg, palette.pageBackground) : null;
    }
    if (!png) continue;
    map.set(source, png);
    ordered.push({ source, ...png });
  }

  if (ordered.length === 0) {
    for (let index = 0; index < live.length; index++) {
      const png = await svgToPng(live[index].svg, palette.pageBackground);
      if (!png) continue;
      const source = live[index].source || `live-mermaid-${index}`;
      map.set(source, png);
      ordered.push({ source, ...png });
    }
  }

  return { map, ordered };
}

export async function renderMermaidSvgs(sources: string[], palette: PdfPalette): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = uniqueSources(sources);
  const live = collectLiveMermaidSvgs();
  if (unique.length === 0 && live.length === 0) return map;

  try {
    const mermaidModule = await import('mermaid');
    const mermaid = mermaidModule.default;

    mermaid.initialize({
      startOnLoad: false,
      suppressErrorRendering: true,
      theme: palette.mermaidTheme as any,
      darkMode: palette.mermaidDarkMode,
      fontFamily: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", Arial, Helvetica, sans-serif',
      // Render labels as SVG <text> (htmlLabels:false) and bound the node width so the
      // text wraps at a max width. This keeps the exported diagram from overflowing or
      // being clipped. (htmlLabels:false avoids foreignObject labels that can't be drawn
      // into the exported PNG and would otherwise be flattened into a single clipped line.)
      htmlLabels: false,
      flowchart: { wrappingWidth: 320 },
      themeVariables: palette.mermaidThemeVariables,
      gantt: { useWidth: 700 },
      pie: { useWidth: 700 },
    } as any);

    for (const source of unique) {
      const tempEl = document.createElement('div');
      tempEl.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
      document.body.appendChild(tempEl);
      try {
        const tempId = 'pdf-mermaid-' + Math.random().toString(36).slice(2, 11);
        tempEl.id = tempId;
        const { svg } = await mermaid.render(tempId, source);
        map.set(source, svg);
      } catch (error) {
        console.warn('[EasyView_Md PDF] Mermaid re-render failed; using editor SVG if available:', error);
      } finally {
        tempEl.remove();
      }
    }
  } catch (error) {
    console.warn('[EasyView_Md PDF] Mermaid import failed; using editor SVG if available:', error);
  }

  for (const item of live) {
    if (item.source && !map.has(item.source)) {
      map.set(item.source, item.svg);
    }
  }

  unique.forEach((source, index) => {
    if (map.has(source)) return;
    const fallback = live.find((item) => item.source === source)?.svg || live[index]?.svg;
    if (fallback) map.set(source, fallback);
  });

  return map;
}

export async function convertMermaidSvgsToPng(
  svgMap: Map<string, string>,
  bgColor: string,
): Promise<Map<string, MermaidPng>> {
  const result = new Map<string, MermaidPng>();

  for (const [source, svgString] of svgMap) {
    try {
      const pngData = await svgToPng(svgString, bgColor);
      if (pngData) {
        result.set(normalizeMermaidSource(source), pngData);
      }
    } catch {
      // Skip invalid SVG — export falls back to a readable code block.
    }
  }

  return result;
}

/**
 * Convert an SVG string to a PNG base64 data URI via Image + Canvas.
 */
export function svgToPng(svgString: string, bgColor = '#ffffff'): Promise<MermaidPng | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: MermaidPng | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(svgString, 'image/svg+xml');
      const svgEl = svgDoc.documentElement;
      if (svgEl.localName !== 'svg' || svgDoc.querySelector('parsererror')) {
        finish(null);
        return;
      }

      flattenForeignObjects(svgEl);

      const viewBox = svgEl.getAttribute('viewBox');
      const viewBoxParts = viewBox?.trim().split(/[\s,]+/) || [];
      const viewBoxWidth = parseFloat(viewBoxParts[2] || '0');
      const viewBoxHeight = parseFloat(viewBoxParts[3] || '0');
      let width = viewBoxWidth || parseFloat(String(svgEl.getAttribute('width') || '').replace(/px$/, '')) || 0;
      let height = viewBoxHeight || parseFloat(String(svgEl.getAttribute('height') || '').replace(/px$/, '')) || 0;

      if (!width || !height) {
        width = 800;
        height = 600;
      }

      svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svgEl.setAttribute('width', String(width));
      svgEl.setAttribute('height', String(height));
      const existingStyle = svgEl.getAttribute('style') || '';
      svgEl.setAttribute('style', `${existingStyle};background:${bgColor};`);

      const scale = 2;
      const padding = 10;
      const radius = 8;
      const borderWidth = 1;
      const borderColor = '#C8CDD4';
      const diagramWidth = Math.max(1, Math.round(width * scale));
      const diagramHeight = Math.max(1, Math.round(height * scale));
      const canvasWidth = diagramWidth + Math.round(padding * 2 * scale);
      const canvasHeight = diagramHeight + Math.round(padding * 2 * scale);

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
          if (!ctx) { finish(null); return; }

          ctx.fillStyle = bgColor;
          ctx.fillRect(0, 0, canvasWidth, canvasHeight);

          const inset = (borderWidth / 2) * scale;
          const boxX = inset;
          const boxY = inset;
          const boxW = canvasWidth - inset * 2;
          const boxH = canvasHeight - inset * 2;
          const boxR = Math.min(radius * scale, boxW / 2, boxH / 2);

          pathRoundedRect(ctx, boxX, boxY, boxW, boxH, boxR);
          ctx.fillStyle = bgColor;
          ctx.fill();
          ctx.save();
          ctx.clip();
          ctx.drawImage(img, padding * scale, padding * scale, diagramWidth, diagramHeight);
          ctx.restore();

          pathRoundedRect(ctx, boxX, boxY, boxW, boxH, boxR);
          ctx.strokeStyle = borderColor;
          ctx.lineWidth = borderWidth * scale;
          ctx.stroke();

          const base64 = canvas.toDataURL('image/png');
          finish({
            base64,
            width: width + padding * 2,
            height: height + padding * 2,
          });
        } catch {
          finish(null);
        }
      };
      img.onerror = () => finish(null);
      setTimeout(() => finish(null), 10000);
      img.src = dataUri;
    } catch {
      finish(null);
    }
  });
}

function pathRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function flattenForeignObjects(svgEl: Element): void {
  const ns = 'http://www.w3.org/2000/svg';
  const foreignObjects = Array.from(svgEl.querySelectorAll('foreignObject'));
  if (foreignObjects.length === 0) return;

  const measure = createTextMeasurer();

  for (const fo of foreignObjects) {
    const lines = extractForeignObjectLines(fo);
    if (lines.length === 0) {
      fo.remove();
      continue;
    }

    const x = parseFloat(fo.getAttribute('x') || '0');
    const y = parseFloat(fo.getAttribute('y') || '0');
    const width = parseFloat(fo.getAttribute('width') || '0');
    const height = parseFloat(fo.getAttribute('height') || '0');
    const fontSize = readForeignObjectFontSize(fo);
    const fontFamily = readForeignObjectFontFamily(fo);
    const font = `${fontSize}px ${fontFamily}`;
    const lineHeight = fontSize * 1.3;

    // Wrap every logical line so it stays inside the node instead of overflowing the
    // foreignObject (which would otherwise be clipped when flattened to SVG <text>).
    const wrapped: string[] = [];
    for (const line of lines) {
      if (width > 0) {
        wrapped.push(...wrapTextToWidth(measure, line, Math.max(fontSize, width - fontSize), font));
      } else {
        wrapped.push(line);
      }
    }

    const centerY = y + height / 2;
    const startY = centerY - ((wrapped.length - 1) * lineHeight) / 2;
    const parent = fo.parentNode;

    wrapped.forEach((lineText, index) => {
      const textEl = svgEl.ownerDocument.createElementNS(ns, 'text');
      textEl.setAttribute('x', String(x + width / 2));
      textEl.setAttribute('y', String(startY + index * lineHeight));
      textEl.setAttribute('text-anchor', 'middle');
      textEl.setAttribute('dominant-baseline', 'middle');
      textEl.setAttribute('font-family', fontFamily);
      textEl.setAttribute('font-size', String(fontSize));
      textEl.setAttribute('fill', '#1f2328');
      textEl.textContent = lineText;
      parent?.insertBefore(textEl, fo);
    });

    fo.remove();
  }
}

type TextMeasurer = (text: string, font: string) => number;

function createTextMeasurer(): TextMeasurer {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  return (text, font) => {
    if (!ctx) return text.length * 14;
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

function readForeignObjectFontSize(fo: Element): number {
  const styled = fo.querySelector('div, span, p, td');
  const raw = (styled as HTMLElement | null)?.style?.fontSize || '';
  const match = raw.match(/(\d+(?:\.\d+)?)px/);
  return match ? parseFloat(match[1]) : 14;
}

function readForeignObjectFontFamily(fo: Element): string {
  const styled = fo.querySelector('div, span, p, td');
  return (
    (styled as HTMLElement | null)?.style?.fontFamily ||
    '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", Arial, Helvetica, sans-serif'
  );
}

/**
 * Extract the logical lines of a flowchart label, preserving explicit line breaks
 * (<br/>) and block boundaries (<div>, <p>, <li>, ...). Otherwise a foreignObject's
 * textContent collapses every line into one long string.
 */
function extractForeignObjectLines(fo: Element): string[] {
  const lines: string[] = [];
  let current = '';

  const flush = () => {
    const value = current.replace(/\s+/g, ' ').trim();
    if (value) lines.push(value);
    current = '';
  };

  const walk = (node: ChildNode) => {
    if (node.nodeType === Node.TEXT_NODE) {
      current += node.textContent || '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') {
      flush();
      return;
    }
    if (tag === 'div' || tag === 'p' || tag === 'li' || tag === 'tr') {
      flush();
      el.childNodes.forEach(walk);
      flush();
      return;
    }
    el.childNodes.forEach(walk);
  };

  fo.childNodes.forEach(walk);
  flush();
  return lines;
}

/**
 * Split text into lines that do not exceed maxWidth. Works for both CJK (character
 * level) and Latin text by just breaking at the widest fitting character/word boundary.
 */
function wrapTextToWidth(measure: TextMeasurer, text: string, maxWidth: number, font: string): string[] {
  if (maxWidth <= 0 || measure(text, font) <= maxWidth) return [text];
  const result: string[] = [];
  let current = '';
  for (const ch of Array.from(text)) {
    const candidate = current + ch;
    if (current && measure(candidate, font) > maxWidth) {
      result.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  if (current) result.push(current);
  return result;
}
