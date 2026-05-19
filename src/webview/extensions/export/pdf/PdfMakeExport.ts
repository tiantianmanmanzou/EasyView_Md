/**
 * PdfMakeExport — converts a ProseMirror document to a pdfmake Document Definition
 * and generates a PDF as base64.
 *
 * Handles ALL InLineMd node types and marks:
 * - Block: paragraph, heading, blockquote, code_block, lists, tables, notice, details,
 *   horizontal_rule, image, frontmatter, footnotes, html_block, description_list, math, TOC,
 *   mermaid (extension node), drawio (extension node)
 * - Inline marks: strong, em, underline, strikethrough, code_inline, highlight, link,
 *   diff_add, diff_del, html_tag (kbd, sub, sup, abbr, var, samp, small, ruby, rt, rp)
 * - Inline nodes: footnote_ref, hard_break, math_inline, html_inline, image
 */

import type { Node as ProsemirrorNode } from 'prosemirror-model';
// pdfmake v0.3.x — official TypeScript import pattern
// @ts-ignore — no bundled type declarations
import * as pdfMake from 'pdfmake/build/pdfmake';
// @ts-ignore
import * as pdfFonts from 'pdfmake/build/vfs_fonts';
// Custom fonts as base64 strings (generated from TTF files)
import { RobotoMonoRegularBase64, RobotoMonoBoldBase64, NotoEmojiRegularBase64 } from './RobotoMonoFonts';

type Content = any;
import { loadAllImages, type LoadFromHostFn } from './PdfImageLoader';
import { getPageConfig, CONTENT_WIDTH } from './PdfStyles';
import { type PdfPalette, LIGHT_PALETTE, DARK_PALETTE } from './PdfPalette';

// Extracted modules
import { collectMermaidSvgs, convertMermaidSvgsToPng } from './PdfMermaidRenderer';
import { collectMathImages } from './PdfMathRenderer';
import { type ConvertContext, convertNode } from './PdfNodeConverters';

// Lazy initialization — deferred until first PDF export to avoid crashing webview on load
let _pdfMakeReady = false;

function ensurePdfMakeReady() {
  if (_pdfMakeReady) return;
  _pdfMakeReady = true;

  try {
    // Register built-in Roboto font files
    // Use .default because esbuild wraps CJS vfs_fonts.js in ESM namespace
    const vfsData = (pdfFonts as any).default || pdfFonts;
    (pdfMake as any).addVirtualFileSystem(vfsData);

    // Register custom fonts for monospace and emoji
    (pdfMake as any).addVirtualFileSystem({
      'RobotoMono-Regular.ttf': RobotoMonoRegularBase64,
      'RobotoMono-Bold.ttf': RobotoMonoBoldBase64,
      'NotoEmoji-Regular.ttf': NotoEmojiRegularBase64,
    });

    // Register font families by mutating the fonts object directly
    // (addFonts() fails in v0.3.4 because `fonts` is a getter-only property)
    const fonts = (pdfMake as any).fonts;
    if (fonts) {
      fonts.RobotoMono = {
        normal: 'RobotoMono-Regular.ttf',
        bold: 'RobotoMono-Bold.ttf',
        italics: 'RobotoMono-Regular.ttf',
        bolditalics: 'RobotoMono-Bold.ttf',
      };
      fonts.NotoEmoji = {
        normal: 'NotoEmoji-Regular.ttf',
        bold: 'NotoEmoji-Regular.ttf',
        italics: 'NotoEmoji-Regular.ttf',
        bolditalics: 'NotoEmoji-Regular.ttf',
      };
    }
  } catch (err) {
    console.error('[InLineMd] pdfmake init failed:', err);
    _pdfMakeReady = false;
    throw err;
  }
}

export interface PdfExportOptions {
  title?: string;
  theme?: 'light' | 'dark';
}

/**
 * Main entry: generate PDF base64 from ProseMirror document.
 */
export async function generatePdfBase64(
  doc: ProsemirrorNode,
  options: PdfExportOptions = {},
  loadImageFromHost?: LoadFromHostFn,
): Promise<string> {
  const palette = options.theme === 'dark' ? DARK_PALETTE : LIGHT_PALETTE;

  // Initialize pdfmake on first call
  ensurePdfMakeReady();

  const t0 = performance.now();

  // Run independent pre-processing steps in parallel:
  // - Image loading (network/DOM)
  // - Mermaid SVG rendering (DOM-based)
  // - Math expression rendering (DOM-based)
  const [imageMap, mermaidSvgMap, mathImageMap] = await Promise.all([
    loadAllImages(doc, loadImageFromHost),
    collectMermaidSvgs(doc, palette),
    collectMathImages(doc, palette.text),
  ]);

  console.log(`[InLineMd PDF] parallel pre-processing: ${(performance.now() - t0).toFixed(0)}ms`);

  // Convert mermaid SVGs to PNG (depends on mermaidSvgMap)
  const t1 = performance.now();
  const mermaidPngMap = await convertMermaidSvgsToPng(mermaidSvgMap, palette.pageBackground);
  console.log(`[InLineMd PDF] mermaid SVG→PNG: ${(performance.now() - t1).toFixed(0)}ms`);

  // Build the pdfmake document definition
  const t2 = performance.now();
  const dd = await buildDocDefinition(doc, imageMap, mermaidSvgMap, mermaidPngMap, mathImageMap, options, palette);
  console.log(`[InLineMd PDF] build doc definition: ${(performance.now() - t2).toFixed(0)}ms`);

  // Generate PDF and return as base64 (pdfmake v0.3.x: async API)
  const t3 = performance.now();
  const pdfDoc = (pdfMake as any).createPdf(dd);
  const base64: string = await pdfDoc.getBase64();
  console.log(`[InLineMd PDF] pdfmake generate: ${(performance.now() - t3).toFixed(0)}ms`);
  console.log(`[InLineMd PDF] TOTAL: ${(performance.now() - t0).toFixed(0)}ms`);
  return base64;
}

/**
 * Build the pdfmake TDocumentDefinitions from a ProseMirror doc.
 */
async function buildDocDefinition(
  doc: ProsemirrorNode,
  imageMap: Map<string, string>,
  mermaidSvgMap: Map<string, string>,
  mermaidPngMap: Map<string, { base64: string; width: number; height: number }>,
  mathImageMap: Map<string, { base64: string; width: number; height: number }>,
  options: PdfExportOptions,
  palette: PdfPalette,
): Promise<any> {
  const ctx: ConvertContext = { imageMap, mermaidSvgMap, mermaidPngMap, mathImageMap, footnotes: [], usedIds: new Set(), palette };

  // Convert all top-level children (async for syntax highlighting)
  const content: Content[] = [];

  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    const result = await convertNode(child, ctx);
    if (result !== null) {
      if (Array.isArray(result)) {
        content.push(...result);
      } else {
        content.push(result);
      }
    }
  }

  // Append footnotes section if any
  if (ctx.footnotes.length > 0) {
    content.push({
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: 150, y2: 0, lineWidth: 0.5, lineColor: palette.footnoteSeparator }],
      margin: [0, 16, 0, 8] as [number, number, number, number],
    } as any);
    content.push(...ctx.footnotes);
  }

  // Prevent orphaned headings: wrap each heading + its next sibling in an
  // unbreakable stack so they always appear on the same page. If the combined
  // block is larger than one page, pdfmake renders it normally (no harm).
  const grouped = groupHeadingsWithContent(content);

  // Post-process: on landscape pages, center non-table content at portrait width
  // so text/headings/etc. don't stretch to 761pt
  const finalContent = centerContentOnLandscapePages(grouped);

  const pageConfig = getPageConfig(palette);

  const dd: any = {
    pageSize: pageConfig.pageSize,
    pageOrientation: pageConfig.pageOrientation,
    pageMargins: pageConfig.pageMargins,
    defaultStyle: pageConfig.defaultStyle,
    content: finalContent,
    info: {
      title: options.title || 'Document',
      creator: 'InLineMd',
    },
    footer(currentPage: number, pageCount: number) {
      return {
        text: `${currentPage} / ${pageCount}`,
        alignment: 'center' as const,
        fontSize: 9,
        color: palette.textFaint,
        margin: [0, 20, 0, 0] as [number, number, number, number],
      };
    },
    // Smart page breaks
    pageBreakBefore(currentNode: any) {
      const pos = currentNode.startPosition;
      if (!pos) return false;

      // A4 height 841.89, top margin 25, bottom margin 50
      const usableHeight = 841.89 - 25 - 50;

      // If a block starts in the bottom third and doesn't fit on one page, move it
      if (currentNode.pageNumbers && currentNode.pageNumbers.length > 1) {
        const threshold = 25 + usableHeight * (2 / 3);
        if (pos.top > threshold) {
          return true;
        }
      }

      return false;
    },
  };

  // Dark theme: fill page background (dynamic size for portrait/landscape)
  if (palette.pageBackground !== '#ffffff') {
    dd.background = (_currentPage: number, pageSize: any) => ({
      canvas: [{
        type: 'rect',
        x: 0, y: 0,
        w: pageSize?.width || 595.28,
        h: pageSize?.height || 841.89,
        color: palette.pageBackground,
      }],
    });
  }

  return dd;
}

/**
 * Group each heading with its next sibling in an unbreakable stack.
 * This prevents orphaned headings at the bottom of a page when the
 * following content (e.g. a table) gets pushed to the next page.
 * If the combined block is larger than one page, pdfmake renders
 * it normally starting from the next page — no visual harm.
 */
function groupHeadingsWithContent(content: Content[]): Content[] {
  const result: Content[] = [];
  for (let i = 0; i < content.length; i++) {
    const item = content[i];

    if (item?.headlineLevel) {
      // Collect all consecutive headings (h2 → h3 → h4 → ...)
      const headings: Content[] = [item];
      let j = i + 1;
      while (j < content.length && content[j]?.headlineLevel) {
        headings.push(content[j]);
        j++;
      }

      // j now points to the first non-heading content after the chain
      if (j < content.length) {
        const next = content[j];

        // Landscape case: move all headings after the marker
        // so they land on the landscape page and get centered
        if (next?._landscapeMarker && j + 1 < content.length) {
          result.push(next);              // landscape marker (pageBreak: 'before')
          for (const h of headings) {
            result.push(h);               // all headings on the landscape page
          }
          result.push(content[j + 1]);    // landscape table
          i = j + 1;
          continue;
        }

        // Normal case: wrap all headings + next content in unbreakable stack
        result.push({
          unbreakable: true,
          stack: [...headings, next],
        });
        i = j; // skip past the content item
        continue;
      }
    }

    result.push(item);
  }
  return result;
}

/**
 * After a landscape table, subsequent elements on the same (landscape) pages
 * would stretch to 761pt. Wrap them in centering columns at portrait width
 * so they look identical to portrait layout. On portrait pages this wrapper
 * is a no-op (515pt centered in 515pt).
 */
function centerContentOnLandscapePages(content: Content[]): Content[] {
  let inLandscape = false;
  const result: Content[] = [];

  for (let i = 0; i < content.length; i++) {
    const item = content[i];

    // Landscape marker — pass through, enter landscape mode
    if (item?._landscapeMarker) {
      inLandscape = true;
      // Clean internal tag (pdfmake might choke on unknown props)
      delete item._landscapeMarker;
      result.push(item);
      continue;
    }

    // Landscape table — pass through (needs full width)
    if (item?._landscapeTable) {
      delete item._landscapeTable;
      result.push(item);
      continue;
    }

    // Not in landscape — pass through unchanged
    if (!inLandscape) {
      result.push(item);
      continue;
    }

    // In landscape: wrap element in centering columns at portrait width
    result.push({
      columns: [
        { width: '*', text: '' },
        { width: CONTENT_WIDTH, stack: [item] },
        { width: '*', text: '' },
      ],
    });
  }

  return result;
}
