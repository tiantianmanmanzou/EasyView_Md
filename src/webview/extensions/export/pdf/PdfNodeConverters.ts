/**
 * PdfNodeConverters — All ProseMirror node-to-pdfmake converters for PDF export.
 */

import type { Node as ProsemirrorNode, Mark } from 'prosemirror-model';
import yaml from 'js-yaml';
import {
  CONTENT_WIDTH,
  CONTENT_WIDTH_LANDSCAPE,
  HEADING_STYLES,
  NOTICE_COLORS,
  tableLayout,
  codeBlockLayout,
  blockquoteLayout,
  noticeLayout,
  detailsLayout,
  frontmatterLayout,
  commentLayout,
} from './PdfStyles';
import { type PdfPalette } from './PdfPalette';
import { highlightCode } from './PdfCodeHighlighting';
import { splitEmoji, splitCodeSegmentsForEmoji, wrapWithEmojiFont, lightenHex, getEmojiColor } from './PdfEmojiUtils';

type Content = any;

// ─── Context ──────────────────────────────────────────────────────────────

export interface ConvertContext {
  imageMap: Map<string, string>;
  mermaidSvgMap: Map<string, string>;
  mermaidPngMap?: Map<string, { base64: string; width: number; height: number }>;
  mathImageMap: Map<string, { base64: string; width: number; height: number }>;
  footnotes: Content[];
  usedIds: Set<string>;
  palette: PdfPalette;
}

// ─── Node Converter (dispatcher) ─────────────────────────────────────────

export async function convertNode(node: ProsemirrorNode, ctx: ConvertContext): Promise<Content | Content[] | null> {
  switch (node.type.name) {
    case 'frontmatter':
      return convertFrontmatter(node, ctx);
    case 'paragraph':
      return convertParagraph(node, ctx);
    case 'heading':
      return convertHeading(node, ctx);
    case 'blockquote':
      return convertBlockquote(node, ctx);
    case 'horizontal_rule':
      return convertHorizontalRule(ctx);
    case 'code_block':
      return convertCodeBlock(node, ctx);
    case 'bullet_list':
      return convertBulletList(node, ctx);
    case 'ordered_list':
      return convertOrderedList(node, ctx);
    case 'checkbox_list':
      return convertCheckboxList(node, ctx);
    case 'list_item':
      return convertListItem(node, ctx);
    case 'checkbox_item':
      return convertCheckboxItem(node, ctx);
    case 'table':
      return convertTable(node, ctx);
    case 'notice':
      return convertNotice(node, ctx);
    case 'details':
      return convertDetails(node, ctx);
    case 'image':
      return convertImage(node, ctx);
    case 'video':
      return convertVideo(node, ctx);
    case 'audio':
      return convertAudio(node, ctx);
    case 'footnote_def':
      return convertFootnoteDef(node, ctx);
    case 'html_block':
      return convertHtmlBlock(node, ctx);
    case 'html_inline':
      return convertHtmlInline(node, ctx);
    case 'description_list':
      return convertDescriptionList(node, ctx);
    case 'table_of_contents':
      return convertToc(ctx);
    case 'math_block':
      return convertMathBlock(node, ctx);
    case 'mermaid':
      return convertMermaidNode(node, ctx);
    case 'drawio':
      return convertDrawio(node, ctx);
    case 'hard_break':
      return '\n';
    default:
      if (node.isBlock && node.content.size > 0) {
        return await convertChildren(node, ctx);
      }
      return null;
  }
}

export async function convertChildren(parent: ProsemirrorNode, ctx: ConvertContext): Promise<Content[]> {
  const result: Content[] = [];
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const converted = await convertNode(child, ctx);
    if (converted !== null) {
      if (Array.isArray(converted)) {
        result.push(...converted);
      } else {
        result.push(converted);
      }
    }
  }
  return result;
}

// ─── Block Converters ────────────────────────────────────────────────────

function convertParagraph(node: ProsemirrorNode, ctx: ConvertContext): Content {
  // Check if paragraph contains only image(s) — render as block-level image(s)
  // (pdfmake doesn't support images inside text arrays)
  let onlyImages = true;
  let hasImage = false;
  node.forEach((child) => {
    if (child.type.name === 'image') {
      hasImage = true;
    } else if (child.isText && child.text?.trim() === '') {
      // whitespace-only text is OK
    } else {
      onlyImages = false;
    }
  });
  if (hasImage && onlyImages) {
    const items: any[] = [];
    node.forEach((child) => {
      if (child.type.name === 'image') {
        items.push(convertImage(child, ctx));
      }
    });
    if (items.length === 1) return items[0];
    return { stack: items, margin: [0, 4, 0, 4] as any };
  }

  // Check if paragraph contains inline media (math images or inline images mixed with text)
  // that require columns layout (pdfmake doesn't support images inside text arrays)
  let hasInlineMedia = false;
  node.forEach((child) => {
    if (child.type.name === 'math_inline') {
      const tex = (child.textContent || '').trim();
      if (ctx.mathImageMap.has(tex)) hasInlineMedia = true;
    } else if (child.type.name === 'image') {
      hasInlineMedia = true;
    }
  });

  if (hasInlineMedia) {
    return convertParagraphWithInlineMedia(node, ctx);
  }

  const inlines = convertInlineContent(node, ctx);
  if (inlines.length === 0) {
    return { text: ' ', margin: [0, 0, 0, 4] as any };
  }

  // pdfmake only registers the first `id` inside a text array as a destination,
  // so we hoist ALL footnote-ref ids to block-level anchors above the paragraph
  const refIds: string[] = [];
  for (const item of inlines) {
    if (item && typeof item === 'object' && typeof item.id === 'string' && item.id.startsWith('footnote-ref-')) {
      refIds.push(item.id);
      delete item.id;
    }
  }

  const textBlock: any = {
    text: inlines,
    lineHeight: 1.25,
    margin: [0, 0, 0, 8],
  };

  if (refIds.length === 0) {
    return textBlock;
  }

  // Each ref gets its own block-level anchor (zero-height text) before the paragraph
  const anchors: any[] = refIds.map(id => ({
    text: '\u200B', id, fontSize: 0.5, lineHeight: 0.01, margin: [0, 0, 0, 0],
  }));
  return { stack: [...anchors, textBlock], margin: [0, 0, 0, 0] as any };
}

/**
 * Convert a paragraph containing inline media (math images and/or inline images)
 * to a columns layout. Splits content into text segments and images placed side-by-side.
 * This works around pdfmake's limitation of not supporting images inside text arrays.
 */
function convertParagraphWithInlineMedia(node: ProsemirrorNode, ctx: ConvertContext): Content {
  const segments: Array<
    | { type: 'text'; items: any[] }
    | { type: 'math'; tex: string }
    | { type: 'image'; node: ProsemirrorNode }
  > = [];
  let currentTextItems: any[] = [];

  node.forEach((child) => {
    if (child.type.name === 'math_inline') {
      const tex = (child.textContent || '').trim();
      if (ctx.mathImageMap.has(tex)) {
        if (currentTextItems.length > 0) {
          segments.push({ type: 'text', items: [...currentTextItems] });
          currentTextItems = [];
        }
        segments.push({ type: 'math', tex });
      } else {
        currentTextItems.push({
          text: `\u2009${tex}\u2009`,
          font: 'RobotoMono',
          fontSize: 9,
          background: ctx.palette.mathBg,
          color: ctx.palette.mathColor,
          italics: true,
        });
      }
    } else if (child.type.name === 'image') {
      if (currentTextItems.length > 0) {
        segments.push({ type: 'text', items: [...currentTextItems] });
        currentTextItems = [];
      }
      segments.push({ type: 'image', node: child });
    } else if (child.isText) {
      const textObj = applyMarks(child.text || '', child.marks, ctx.palette);
      const emojiSegments = wrapWithEmojiFont(textObj);
      currentTextItems.push(...emojiSegments);
    } else {
      // Other inline nodes (hard_break, footnote_ref, etc.)
      const inlineResult = convertInlineNode(child, ctx);
      if (inlineResult !== null) {
        currentTextItems.push(inlineResult);
      }
    }
  });

  if (currentTextItems.length > 0) {
    segments.push({ type: 'text', items: currentTextItems });
  }

  if (segments.length === 0) {
    return { text: ' ', margin: [0, 0, 0, 4] as any };
  }

  // Pseudo-flex layout: estimate widths and pack segments into rows (like CSS flex-wrap).
  // When a segment would overflow the current row, start a new row.
  // This prevents text from being squeezed into a narrow column.
  const AVG_CHAR_WIDTH = 4.5;

  // Estimate widths for each segment
  const segWidths: number[] = segments.map((seg) => {
    if (seg.type === 'text') {
      const charCount = seg.items.reduce((sum: number, item: any) => {
        const t = typeof item === 'string' ? item : item?.text || '';
        return sum + t.length;
      }, 0);
      return charCount * AVG_CHAR_WIDTH;
    } else if (seg.type === 'math') {
      const mathImage = ctx.mathImageMap.get(seg.tex);
      if (!mathImage) return 60;
      const scale = 24 / mathImage.height;
      return Math.ceil(mathImage.width * scale) + 4;
    } else {
      // image
      const nodeWidth = seg.node.attrs.width;
      return (nodeWidth && nodeWidth > 0) ? Math.min(nodeWidth, CONTENT_WIDTH) + 4 : CONTENT_WIDTH * 0.5 + 4;
    }
  });

  // Pseudo-flex: pack segments into rows.
  // Only math/image (fixed-width) can trigger row breaks.
  // Text segments ALWAYS join the current row — overflow is handled by splitting.
  const rows: number[][] = [];
  let currentRow: number[] = [];
  let currentFixedX = 0; // only tracks fixed-width items

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'text') {
      // Text never breaks rows — will be split later if needed
      currentRow.push(i);
    } else {
      // Math/image: break if this fixed item wouldn't fit
      const segW = segWidths[i];
      if (currentRow.length > 0 && currentFixedX + segW > CONTENT_WIDTH) {
        rows.push(currentRow);
        currentRow = [i];
        currentFixedX = segW;
      } else {
        currentRow.push(i);
        currentFixedX += segW;
      }
    }
  }
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  // Helper: split text items array at a character budget.
  // Returns [itemsThatFit, itemsOverflow].
  function splitTextItems(items: any[], charBudget: number): [any[], any[]] {
    const first: any[] = [];
    const rest: any[] = [];
    let used = 0;
    let overflowed = false;
    for (const item of items) {
      if (overflowed) { rest.push(item); continue; }
      const txt: string = typeof item === 'string' ? item : item?.text || '';
      if (used + txt.length <= charBudget) {
        first.push(item);
        used += txt.length;
      } else {
        // Split this item at a word boundary
        const remaining = charBudget - used;
        let splitPos = txt.lastIndexOf(' ', remaining);
        if (splitPos <= 0) splitPos = txt.indexOf(' ', remaining);
        if (splitPos <= 0) {
          // No good split point — put entire item in overflow
          rest.push(item);
        } else {
          const partA = txt.slice(0, splitPos + 1); // include the space
          const partB = txt.slice(splitPos + 1);
          if (typeof item === 'string') {
            if (partA) first.push(partA);
            if (partB) rest.push(partB);
          } else {
            if (partA) first.push({ ...item, text: partA });
            if (partB) rest.push({ ...item, text: partB });
          }
        }
        overflowed = true;
      }
    }
    return [first, rest];
  }

  // Helper: build a math column
  function buildMathCol(seg: { type: 'math'; tex: string }) {
    const mathImage = ctx.mathImageMap.get(seg.tex)!;
    const scale = 24 / mathImage.height;
    return {
      width: 'auto' as const,
      stack: [{
        image: mathImage.base64,
        width: Math.ceil(mathImage.width * scale),
        height: Math.ceil(mathImage.height * scale),
      }],
      margin: [2, -5, 2, 0] as [number, number, number, number],
    };
  }

  // Helper: build an image column
  function buildImageCol(seg: { type: 'image'; node: ProsemirrorNode }) {
    const imgNode = seg.node;
    const imgSrc = imgNode.attrs.src || '';
    const imgOrigSrc = imgNode.attrs.originalSrc || '';
    let imgBase64 = ctx.imageMap.get(imgSrc);
    if (!imgBase64 && imgOrigSrc) imgBase64 = ctx.imageMap.get(imgOrigSrc);
    if (imgBase64) {
      const nodeWidth = imgNode.attrs.width;
      const imgDef: any = { image: imgBase64 };
      if (nodeWidth && nodeWidth > 0) {
        imgDef.width = Math.min(nodeWidth, CONTENT_WIDTH);
      } else {
        imgDef.fit = [CONTENT_WIDTH * 0.5, 300];
      }
      return {
        width: 'auto' as const,
        stack: [imgDef],
        margin: [2, 4, 2, 4] as [number, number, number, number],
      };
    }
    const alt = imgNode.attrs.alt || '[image]';
    return {
      width: 'auto' as const,
      text: [{ text: alt, color: ctx.palette.textFaint, italics: true, fontSize: 9 }],
      lineHeight: 1.25,
    };
  }

  // Build pdfmake blocks for each row.
  // For mixed rows that overflow: trailing text after last math/image is split —
  // part that fits goes in the columns row, remainder becomes a paragraph below
  // so wrapped text starts from the left margin (not indented inside a column).
  const rowBlocks: any[] = [];

  for (const row of rows) {
    const allText = row.every(i => segments[i].type === 'text');
    if (allText) {
      const merged: any[] = [];
      for (const i of row) merged.push(...(segments[i] as any).items);
      rowBlocks.push({ text: merged, lineHeight: 1.25 });
      continue;
    }

    const totalRowW = row.reduce((sum, i) => sum + segWidths[i], 0);
    if (totalRowW <= CONTENT_WIDTH) {
      // Everything fits — all auto, compact
      const cols: any[] = [];
      for (const i of row) {
        const seg = segments[i];
        if (seg.type === 'text') {
          cols.push({ width: 'auto', text: seg.items, lineHeight: 1.25 });
        } else if (seg.type === 'math') {
          cols.push(buildMathCol(seg));
        } else {
          cols.push(buildImageCol(seg as any));
        }
      }
      rowBlocks.push({ columns: cols, columnGap: 0 });
      continue;
    }

    // Overflowing mixed row: build columns with auto for everything,
    // but split the trailing text so overflow goes to a new paragraph.
    // Calculate width used by non-trailing-text items.
    let lastFixedPos = -1;
    for (let r = row.length - 1; r >= 0; r--) {
      if (segments[row[r]].type !== 'text') { lastFixedPos = r; break; }
    }

    // Width used by columns up to and including the last fixed item + text before it
    let usedW = 0;
    for (let r = 0; r <= lastFixedPos; r++) {
      usedW += segWidths[row[r]];
    }

    // Collect trailing text items (after last math/image)
    const trailingTextItems: any[] = [];
    for (let r = lastFixedPos + 1; r < row.length; r++) {
      trailingTextItems.push(...(segments[row[r]] as any).items);
    }

    const availableW = CONTENT_WIDTH - usedW;
    const charBudget = Math.max(Math.floor(availableW / AVG_CHAR_WIDTH), 0);

    const [fitItems, overflowItems] = charBudget > 0 && trailingTextItems.length > 0
      ? splitTextItems(trailingTextItems, charBudget)
      : [[], trailingTextItems];

    // Build columns: everything up to last fixed + text between, all auto
    const cols: any[] = [];
    for (let r = 0; r <= lastFixedPos; r++) {
      const i = row[r];
      const seg = segments[i];
      if (seg.type === 'text') {
        cols.push({ width: 'auto', text: seg.items, lineHeight: 1.25 });
      } else if (seg.type === 'math') {
        cols.push(buildMathCol(seg));
      } else {
        cols.push(buildImageCol(seg as any));
      }
    }
    // Add the part of trailing text that fits
    if (fitItems.length > 0) {
      cols.push({ width: '*', text: fitItems, lineHeight: 1.25 });
    }

    rowBlocks.push({ columns: cols, columnGap: 0 });

    // Overflow text -> separate paragraph (starts from left margin)
    if (overflowItems.length > 0) {
      rowBlocks.push({ text: overflowItems, lineHeight: 1.25 });
    }
  }

  if (rowBlocks.length === 1) {
    return { ...rowBlocks[0], margin: [0, 0, 0, 8] as [number, number, number, number] };
  }

  return {
    stack: rowBlocks,
    margin: [0, 0, 0, 8] as [number, number, number, number],
  };
}

function convertHeading(node: ProsemirrorNode, ctx: ConvertContext): Content {
  const level = node.attrs.level || 1;
  const style = HEADING_STYLES[level] || HEADING_STYLES[1];
  const inlines = convertInlineContent(node, ctx);
  // Generate unique slug for internal link anchors
  let slug = (node.textContent || '').toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) slug = 'heading';
  // Ensure uniqueness
  let uniqueSlug = slug;
  let counter = 1;
  while (ctx.usedIds.has(uniqueSlug)) {
    uniqueSlug = `${slug}-${counter++}`;
  }
  ctx.usedIds.add(uniqueSlug);
  return {
    text: inlines,
    fontSize: style.fontSize,
    bold: true,
    margin: style.margin,
    tocItem: true,
    tocMargin: [level === 1 ? 0 : (level - 1) * 10, 0, 0, 0] as any,
    id: uniqueSlug,
    headlineLevel: level,
  };
}

async function convertBlockquote(node: ProsemirrorNode, ctx: ConvertContext): Promise<Content> {
  const children = await convertChildren(node, ctx);
  return {
    unbreakable: true,
    table: {
      widths: ['*'],
      body: [[{ stack: children, color: ctx.palette.textMedium, italics: true }]],
    },
    layout: blockquoteLayout(ctx.palette),
    margin: [0, 4, 0, 4] as [number, number, number, number],
  } as any;
}

function convertHorizontalRule(ctx: ConvertContext): Content {
  return {
    canvas: [
      { type: 'line', x1: 0, y1: 0, x2: CONTENT_WIDTH, y2: 0, lineWidth: 0.5, lineColor: ctx.palette.hrColor },
    ],
    margin: [0, 8, 0, 8] as [number, number, number, number],
  } as any;
}

async function convertCodeBlock(node: ProsemirrorNode, ctx: ConvertContext): Promise<Content> {
  const language = node.attrs.language || '';
  const text = (node.textContent || '').replace(/\n+$/, ''); // trim trailing newlines

  // Check if this is a mermaid diagram
  if (language === 'mermaid' || language === 'mermaidjs') {
    return convertMermaidBlock(text, ctx);
  }

  // Highlight code using refractor (same library as editor, no DOM dependency)
  const highlighted = language ? await highlightCode(text, language, ctx.palette) : null;

  const header: Content[] = [];
  if (language) {
    header.push({
      text: language,
      fontSize: 8,
      color: ctx.palette.textMuted,
      bold: true,
      alignment: 'right' as const,
      margin: [0, 0, 0, 4] as any,
    });
  }

  // Build code content — with syntax highlighting if available
  let codeContent: Content;
  if (highlighted && highlighted.length > 0) {
    // Use refractor syntax highlighting, trim trailing whitespace
    let segments = highlighted.map(seg => ({
      text: seg.text,
      color: seg.color || ctx.palette.prismDefaultColor,
    }));
    // Remove trailing empty/whitespace segments
    while (segments.length > 0) {
      const last = segments[segments.length - 1];
      if (!last.text.trim()) {
        segments.pop();
      } else {
        last.text = last.text.replace(/\n+$/, '');
        break;
      }
    }
    // Split emoji out of code segments so they render with NotoEmoji font
    const emojiSplit = splitCodeSegmentsForEmoji(segments);
    codeContent = {
      text: emojiSplit,
      font: 'RobotoMono',
      fontSize: 9,
      lineHeight: 1.4,
      preserveLeadingSpaces: true,
    };
  } else {
    // Fallback: plain text — split emoji for NotoEmoji font
    const parts = splitEmoji(text);
    const hasEmoji = parts.some(p => p.isEmoji);
    if (hasEmoji) {
      codeContent = {
        text: parts.map(p => p.isEmoji
          ? { text: p.text, font: 'NotoEmoji' }
          : { text: p.text }
        ),
        font: 'RobotoMono',
        fontSize: 9,
        lineHeight: 1.4,
        preserveLeadingSpaces: true,
      };
    } else {
      codeContent = {
        text: text,
        font: 'RobotoMono',
        fontSize: 9,
        lineHeight: 1.4,
        preserveLeadingSpaces: true,
      };
    }
  }

  return {
    table: {
      widths: ['*'],
      body: [[{
        stack: [
          ...header,
          codeContent,
        ],
      }]],
    },
    layout: codeBlockLayout(ctx.palette),
    margin: [0, 4, 0, 8] as [number, number, number, number],
  } as any;
}

function convertMermaidBlock(text: string, ctx: ConvertContext): Content {
  // A4 height (841.89) - top margin (25) - bottom margin (50) - diagram margins (16)
  const MAX_HEIGHT = 750;

  const pngData = ctx.mermaidPngMap?.get(text);
  if (pngData) {
    const result: any = {
      image: pngData.base64,
      alignment: 'center' as const,
      margin: [0, 8, 0, 8] as [number, number, number, number],
    };
    // Use original size; fit proportionally if exceeds page width OR height
    if (pngData.width > CONTENT_WIDTH || pngData.height > MAX_HEIGHT) {
      result.fit = [CONTENT_WIDTH, MAX_HEIGHT];
    } else {
      result.width = pngData.width;
    }
    return result;
  }
  // Fallback: try SVG directly (may have rendering issues)
  const svg = ctx.mermaidSvgMap.get(text);
  if (svg) {
    try {
      return {
        svg: svg,
        fit: [CONTENT_WIDTH, MAX_HEIGHT],
        alignment: 'center' as const,
        margin: [0, 8, 0, 8] as [number, number, number, number],
      } as any;
    } catch {
      // fallback below
    }
  }
  // Fallback: show as code block
  return {
    table: {
      widths: ['*'],
      body: [[{
        stack: [
          { text: 'mermaid', fontSize: 8, color: ctx.palette.textMuted, bold: true, alignment: 'right' as const, margin: [0, 0, 0, 4] as any },
          { text: text, font: 'RobotoMono', fontSize: 9, lineHeight: 1.4, preserveLeadingSpaces: true },
        ],
      }]],
    },
    layout: codeBlockLayout(ctx.palette),
    margin: [0, 4, 0, 8] as [number, number, number, number],
  } as any;
}

/**
 * Convert a `mermaid` node (from MermaidExtension) — separate from code_block mermaid.
 * Uses attrs.content for the mermaid source.
 */
function convertMermaidNode(node: ProsemirrorNode, ctx: ConvertContext): Content {
  const text = node.attrs.content || '';
  return convertMermaidBlock(text, ctx);
}

/**
 * Convert a `drawio` node (from DrawioExtension) — placeholder since Draw.io is external.
 */
function convertDrawio(node: ProsemirrorNode, ctx: ConvertContext): Content {
  const title = node.attrs.title || 'Draw.io Diagram';
  return {
    table: {
      widths: ['*'],
      body: [[{
        text: [
          { text: '📊 ', font: 'NotoEmoji', fontSize: 12 },
          { text: title, bold: true, color: ctx.palette.textMedium },
          { text: '\n(Draw.io diagram \u2014 not renderable in PDF)', fontSize: 9, color: ctx.palette.textFaint, italics: true },
        ],
      }]],
    },
    layout: detailsLayout(ctx.palette),
    margin: [0, 4, 0, 8] as [number, number, number, number],
  } as any;
}

async function convertBulletList(node: ProsemirrorNode, ctx: ConvertContext): Promise<Content> {
  const rows: Content[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const content = await convertListItemContent(child, ctx);
    rows.push({
      columns: [
        { width: 15, text: '•', fontSize: 11, color: ctx.palette.textMedium },
        { width: '*', ...(typeof content === 'string' ? { text: content } : content) },
      ],
      columnGap: 4,
      margin: [0, 1, 0, 1] as any,
    });
  }
  return {
    stack: rows,
    margin: [0, 2, 0, 6] as [number, number, number, number],
  };
}

async function convertOrderedList(node: ProsemirrorNode, ctx: ConvertContext): Promise<Content> {
  const rows: Content[] = [];
  const start = node.attrs.order || 1;
  let index = 0;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const content = await convertListItemContent(child, ctx);
    rows.push({
      columns: [
        { width: 20, text: `${start + index}.`, fontSize: 11, alignment: 'right' as const },
        { width: '*', ...(typeof content === 'string' ? { text: content } : content) },
      ],
      columnGap: 4,
      margin: [0, 1, 0, 1] as any,
    });
    index++;
  }
  return {
    stack: rows,
    margin: [0, 2, 0, 6] as [number, number, number, number],
  };
}

async function convertCheckboxList(node: ProsemirrorNode, ctx: ConvertContext): Promise<Content> {
  const rows: Content[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const checked = child.attrs.checked;
    const content = await convertListItemContent(child, ctx);
    const contentObj = typeof content === 'string' ? { text: content } : content;

    // Draw checkbox with canvas for crisp rendering
    let checkboxCanvas: Content;
    const boxSize = 10;
    const boxY = 2;
    if (checked === true) {
      // Checked: filled green box with white checkmark
      checkboxCanvas = {
        canvas: [
          { type: 'rect', x: 0, y: boxY, w: boxSize, h: boxSize, r: 1.5, lineWidth: 0, color: ctx.palette.checkboxCheckedBg },
          { type: 'line', x1: 2, y1: boxY + 5.5, x2: 4.5, y2: boxY + 8, lineWidth: 1.5, lineColor: '#fff', lineCap: 'round' },
          { type: 'line', x1: 4.5, y1: boxY + 8, x2: 8.5, y2: boxY + 2.5, lineWidth: 1.5, lineColor: '#fff', lineCap: 'round' },
        ],
        width: boxSize,
      };
    } else if (checked === 'inapplicable') {
      // Inapplicable: gray box with X
      checkboxCanvas = {
        canvas: [
          { type: 'rect', x: 0, y: boxY, w: boxSize, h: boxSize, r: 1.5, lineWidth: 0, color: ctx.palette.checkboxMutedBg },
          { type: 'line', x1: 2.5, y1: boxY + 2.5, x2: 7.5, y2: boxY + 7.5, lineWidth: 1.5, lineColor: '#fff', lineCap: 'round' },
          { type: 'line', x1: 7.5, y1: boxY + 2.5, x2: 2.5, y2: boxY + 7.5, lineWidth: 1.5, lineColor: '#fff', lineCap: 'round' },
        ],
        width: boxSize,
      };
    } else {
      // Unchecked: outlined box
      checkboxCanvas = {
        canvas: [
          { type: 'rect', x: 0, y: boxY, w: boxSize, h: boxSize, r: 1.5, lineWidth: 1, lineColor: ctx.palette.checkboxBorder },
        ],
        width: boxSize,
      };
    }

    rows.push({
      columns: [
        { width: 16, ...checkboxCanvas },
        {
          width: '*',
          ...contentObj,
          ...(checked === true ? { decoration: 'lineThrough' as const, color: ctx.palette.textFaint } : {}),
        },
      ],
      columnGap: 5,
      margin: [0, 1, 0, 1] as any,
    });
  }
  return {
    stack: rows,
    margin: [0, 2, 0, 6] as [number, number, number, number],
  };
}

async function convertListItem(node: ProsemirrorNode, ctx: ConvertContext): Promise<Content> {
  return convertListItemContent(node, ctx);
}

async function convertCheckboxItem(node: ProsemirrorNode, ctx: ConvertContext): Promise<Content> {
  return convertListItemContent(node, ctx);
}

/**
 * Convert the content of a list_item or checkbox_item.
 * If the item has a single paragraph, return its text content directly.
 * If it has multiple blocks, wrap in a stack.
 */
async function convertListItemContent(node: ProsemirrorNode, ctx: ConvertContext): Promise<Content> {
  const blocks: Content[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const converted = await convertNode(child, ctx);
    if (converted !== null) {
      if (Array.isArray(converted)) {
        blocks.push(...converted);
      } else {
        blocks.push(converted);
      }
    }
  }

  if (blocks.length === 1) {
    return blocks[0];
  }

  return { stack: blocks };
}

async function convertTable(node: ProsemirrorNode, ctx: ConvertContext): Promise<Content> {
  const rows: Content[][] = [];
  let headerRows = 0;
  let columnCount = 0;
  const alignments: (string | null)[] = [];

  for (let rowIdx = 0; rowIdx < node.childCount; rowIdx++) {
    const row = node.child(rowIdx);
    const cells: Content[] = [];
    let isHeader = false;

    for (let cellIdx = 0; cellIdx < row.childCount; cellIdx++) {
      const cell = row.child(cellIdx);
      const isHeaderCell = cell.type.name === 'table_header';
      if (isHeaderCell) isHeader = true;

      if (rowIdx === 0) {
        alignments.push(cell.attrs.alignment || null);
      }

      const cellContent = await convertChildren(cell, ctx);
      const alignment = cell.attrs.alignment || undefined;

      // Check for keyword badges (TRUE, FALSE, NULL, etc.)
      const kwColor = getTableKeywordColor(cell.textContent.trim());
      if (kwColor) {
        applyKeywordBadge(cellContent, kwColor, ctx.palette);
      }

      const cellDef: any = {
        stack: cellContent.length > 0 ? cellContent : [{ text: ' ' }],
        ...(alignment ? { alignment } : {}),
        ...(isHeaderCell ? { bold: true, fillColor: ctx.palette.tableHeaderFill } : {}),
      };

      if (cell.attrs.colspan > 1) cellDef.colSpan = cell.attrs.colspan;
      if (cell.attrs.rowspan > 1) cellDef.rowSpan = cell.attrs.rowspan;

      cells.push(cellDef);
    }

    if (rowIdx === 0) columnCount = cells.length;
    if (isHeader) headerRows++;
    rows.push(cells);
  }

  if (rows.length === 0) return { text: '' };

  // Ensure all rows have the same number of cells
  for (const row of rows) {
    while (row.length < columnCount) {
      row.push({ text: '' });
    }
  }

  const result = calculateTableWidths(rows, columnCount);

  const tableNode: any = {
    table: {
      headerRows: Math.max(headerRows, 0),
      widths: result.widths,
      body: rows,
      dontBreakRows: true,
      keepWithHeaderRows: 1,
    },
    layout: tableLayout(ctx.palette),
  };

  if (result.fontSize) {
    tableNode.fontSize = result.fontSize;
  }

  if (result.landscape) {
    // Wide table — rotate to landscape page.
    // pageOrientation only works on text nodes in pdfmake, so use
    // a zero-height text marker to switch orientation.
    // Subsequent elements are centered at portrait width by buildDocDefinition.
    const items: any[] = [];

    // Switch to landscape
    items.push({
      text: '\u200B',
      fontSize: 0.5,
      lineHeight: 0.01,
      margin: [0, 0, 0, 0] as [number, number, number, number],
      pageBreak: 'before',
      pageOrientation: 'landscape',
      _landscapeMarker: true,
    });

    // The table itself
    if (!result.scaled) {
      items.push({
        columns: [
          { width: '*', text: '' },
          { width: 'auto', ...tableNode },
          { width: '*', text: '' },
        ],
        margin: [0, 4, 0, 8] as [number, number, number, number],
        _landscapeTable: true,
      });
    } else {
      items.push({
        ...tableNode,
        margin: [0, 4, 0, 8] as [number, number, number, number],
        _landscapeTable: true,
      });
    }

    return items as any;
  }

  if (!result.scaled) {
    // Table fits portrait naturally — center with flexible spacers
    return {
      columns: [
        { width: '*', text: '' },
        { width: 'auto', ...tableNode },
        { width: '*', text: '' },
      ],
      margin: [0, 4, 0, 8] as [number, number, number, number],
    } as any;
  }

  // Table was scaled to fit portrait — full width
  return {
    ...tableNode,
    margin: [0, 4, 0, 8] as [number, number, number, number],
  } as any;
}

async function convertNotice(node: ProsemirrorNode, ctx: ConvertContext): Promise<Content> {
  const style = node.attrs.style || 'note';
  const color = NOTICE_COLORS[style] || NOTICE_COLORS.note;
  const bgColor = ctx.palette.noticeBg[style] || ctx.palette.noticeBg.note;

  const children = await convertChildren(node, ctx);

  // Remove bottom margin from the last child to avoid extra padding inside the notice
  if (children.length > 0) {
    const last = children[children.length - 1];
    if (last && typeof last === 'object' && last.margin) {
      last.margin = [last.margin[0] || 0, last.margin[1] || 0, last.margin[2] || 0, 0];
    }
  }

  return {
    unbreakable: true,
    table: {
      widths: ['*'],
      body: [[{
        stack: children,
      }]],
    },
    layout: noticeLayout(color, bgColor, ctx.palette),
    margin: [0, 0, 0, 0] as [number, number, number, number],
  } as any;
}

async function convertDetails(node: ProsemirrorNode, ctx: ConvertContext): Promise<Content> {
  const summary = node.attrs.summary || 'Details';
  const children = await convertChildren(node, ctx);

  return {
    unbreakable: true,
    table: {
      widths: ['*'],
      body: [
        [{ text: [{ text: 'v ', fontSize: 9, font: 'RobotoMono', color: ctx.palette.textMuted }, { text: summary, bold: true }], fillColor: ctx.palette.detailsHeaderFill }],
        [{ stack: children.length > 0 ? children : [{ text: ' ' }] }],
      ],
    },
    layout: detailsLayout(ctx.palette),
    margin: [0, 4, 0, 8] as [number, number, number, number],
  } as any;
}

function convertImage(node: ProsemirrorNode, ctx: ConvertContext): Content {
  const src = node.attrs.src || '';
  const originalSrc = node.attrs.originalSrc || '';
  const alt = node.attrs.alt || '';
  // Try src first, then originalSrc as fallback key
  let base64 = ctx.imageMap.get(src);
  if (!base64 && originalSrc) {
    base64 = ctx.imageMap.get(originalSrc);
  }
  // If still not found, try to find by substring match (webview URIs can differ slightly)
  if (!base64) {
    for (const [key, value] of ctx.imageMap.entries()) {
      if (key.includes(originalSrc) || (originalSrc && key.endsWith(encodeURIComponent(originalSrc)))) {
        base64 = value;
        break;
      }
    }
  }
  if (!base64) { /* image not in map — will use fallback placeholder */ }

  if (base64) {
    const result: any = {
      image: base64,
      fit: [CONTENT_WIDTH, 600],
      margin: [0, 4, 0, 4] as [number, number, number, number],
    };
    if (alt) {
      return {
        stack: [
          result,
          { text: alt, fontSize: 9, color: ctx.palette.textMuted, italics: true, margin: [0, 2, 0, 4] as any },
        ],
      };
    }
    return result;
  }

  // Fallback: show placeholder text
  return {
    text: alt ? `[Image: ${alt}]` : '[Image]',
    color: ctx.palette.textFaint,
    italics: true,
    margin: [0, 4, 0, 4] as [number, number, number, number],
  };
}

function convertVideo(node: ProsemirrorNode, ctx: ConvertContext): Content {
  const alt = node.attrs.alt || node.attrs.title || '';
  return {
    text: alt ? `[Video: ${alt}]` : '[Video]',
    color: ctx.palette.textFaint,
    italics: true,
    margin: [0, 4, 0, 4] as [number, number, number, number],
  };
}

function convertAudio(node: ProsemirrorNode, ctx: ConvertContext): Content {
  const alt = node.attrs.alt || node.attrs.title || '';
  return {
    text: alt ? `[Audio: ${alt}]` : '[Audio]',
    color: ctx.palette.textFaint,
    italics: true,
    margin: [0, 4, 0, 4] as [number, number, number, number],
  };
}

async function convertFootnoteDef(node: ProsemirrorNode, ctx: ConvertContext): Promise<null> {
  const label = node.attrs.label || '';
  const children = await convertChildren(node, ctx);

  // Style like the editor: blue left border, light gray background, small font
  ctx.footnotes.push({
    table: {
      widths: ['*'],
      body: [[{
        stack: [
          {
            text: [
              { text: `[^${label}]:`, bold: true, fontSize: 8, color: ctx.palette.link, linkToDestination: `footnote-ref-${label}` },
            ],
            id: `footnote-${label}`,
            margin: [0, 0, 0, 3] as any,
          },
          ...children.map((c: any) => ({
            ...c,
            fontSize: 9,
            color: ctx.palette.textSecondary,
          })),
        ],
      }]],
    },
    layout: {
      hLineWidth() { return 0; },
      vLineWidth(i: number) { return i === 0 ? 2.5 : 0; },
      hLineColor() { return ctx.palette.pageBackground; },
      vLineColor() { return ctx.palette.footnoteBarBorder; },
      paddingLeft() { return 10; },
      paddingRight() { return 8; },
      paddingTop() { return 5; },
      paddingBottom() { return 5; },
      fillColor() { return ctx.palette.footnoteBarBg; },
    },
    margin: [0, 2, 0, 4] as [number, number, number, number],
  } as any);

  // Don't render inline — footnotes go at the end
  return null;
}

/** Regex to detect HTML comment blocks */
const COMMENT_RE = /^\s*<!--([\s\S]*?)-->\s*$/;

function extractComment(html: string): string | null {
  const match = html.match(COMMENT_RE);
  return match ? match[1].trim() : null;
}

function convertHtmlBlock(node: ProsemirrorNode, ctx: ConvertContext): Content {
  const html = node.attrs.html || '';
  const comment = extractComment(html);

  if (comment !== null) {
    return {
      table: {
        widths: ['*'],
        body: [[{
          text: [
            { text: '💬 ', fontSize: 10, font: 'NotoEmoji' },
            { text: comment, italics: true, color: ctx.palette.textFaint },
          ],
        }]],
      },
      layout: commentLayout(ctx.palette),
      margin: [0, 4, 0, 4] as [number, number, number, number],
    } as any;
  }

  // Non-comment HTML block
  return {
    table: {
      widths: ['*'],
      body: [[{
        text: html,
        font: 'RobotoMono',
        fontSize: 9,
        color: ctx.palette.textMuted,
        preserveLeadingSpaces: true,
      }]],
    },
    layout: codeBlockLayout(ctx.palette),
    margin: [0, 4, 0, 4] as [number, number, number, number],
  } as any;
}

function convertHtmlInline(node: ProsemirrorNode, ctx: ConvertContext): Content {
  return {
    text: node.attrs.html || '',
    font: 'RobotoMono',
    fontSize: 9,
    color: ctx.palette.textMuted,
  };
}

async function convertDescriptionList(node: ProsemirrorNode, ctx: ConvertContext): Promise<Content> {
  const items: Content[] = [];

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type.name === 'description_term') {
      const inlines = convertInlineContent(child, ctx);
      items.push({
        text: inlines,
        bold: true,
        margin: [0, 6, 0, 2] as [number, number, number, number],
      });
    } else if (child.type.name === 'description_detail') {
      const children = await convertChildren(child, ctx);
      items.push({
        stack: children,
        margin: [20, 0, 0, 4] as [number, number, number, number],
      });
    }
  }

  return {
    stack: items,
    margin: [0, 4, 0, 8] as [number, number, number, number],
  };
}

function convertToc(ctx: ConvertContext): Content {
  return {
    toc: {
      title: { text: 'Table of Contents', bold: true, fontSize: 14, margin: [0, 0, 0, 8] as any },
      textStyle: { color: ctx.palette.link },
      numberStyle: { color: ctx.palette.textMuted },
    },
    margin: [0, 8, 0, 16] as [number, number, number, number],
  } as any;
}

function convertMathBlock(node: ProsemirrorNode, ctx: ConvertContext): Content {
  const tex = (node.textContent || '').trim();

  // Use pre-rendered image if available
  const mathImage = ctx.mathImageMap.get(tex);
  if (mathImage) {
    return {
      image: mathImage.base64,
      fit: [Math.min(mathImage.width, CONTENT_WIDTH), mathImage.height],
      alignment: 'center' as const,
      margin: [0, 8, 0, 8] as [number, number, number, number],
    } as any;
  }

  // Fallback: show TeX source in a styled block
  return {
    table: {
      widths: ['*'],
      body: [[{
        text: tex || ' ',
        font: 'RobotoMono',
        fontSize: 10,
        alignment: 'center' as const,
        color: ctx.palette.textDark,
        italics: true,
      }]],
    },
    layout: {
      hLineWidth() { return 0; },
      vLineWidth() { return 0; },
      paddingLeft() { return 20; },
      paddingRight() { return 20; },
      paddingTop() { return 8; },
      paddingBottom() { return 8; },
      fillColor() { return ctx.palette.mathBlockFill; },
    },
    margin: [0, 8, 0, 8] as [number, number, number, number],
  } as any;
}

/** Format a frontmatter value for PDF display, matching the editor's visual style */
function formatFmValue(value: unknown, palette: PdfPalette): any {
  if (value === null || value === undefined) {
    return { text: '', fontSize: 10 };
  }

  // Date -> ISO string in code style (red on pink bg)
  if (value instanceof Date) {
    const iso = value.toISOString();
    return {
      text: `\u2009${iso}\u2009`,
      font: 'RobotoMono',
      fontSize: 9,
      color: palette.fmDateColor,
      background: palette.fmDateBg,
    };
  }

  // Array -> badges/pills
  if (Array.isArray(value)) {
    const items: any[] = [];
    for (let i = 0; i < value.length; i++) {
      if (i > 0) items.push({ text: '  ', fontSize: 10 });
      items.push({
        text: `\u2009${String(value[i])}\u2009`,
        font: 'RobotoMono',
        fontSize: 9,
        background: palette.fmBadgeBg,
        color: palette.fmBadgeColor,
      });
    }
    return items.length > 0 ? items : { text: '', fontSize: 10 };
  }

  // Boolean -> code style
  if (typeof value === 'boolean') {
    return {
      text: `\u2009${String(value)}\u2009`,
      font: 'RobotoMono',
      fontSize: 9,
      color: palette.fmBoolColor,
      background: palette.fmBoolBg,
    };
  }

  // Number -> code style
  if (typeof value === 'number') {
    return {
      text: `\u2009${String(value)}\u2009`,
      font: 'RobotoMono',
      fontSize: 9,
      color: palette.fmBoolColor,
      background: palette.fmBoolBg,
    };
  }

  // Object -> JSON in code style
  if (typeof value === 'object') {
    return {
      text: `\u2009${JSON.stringify(value)}\u2009`,
      font: 'RobotoMono',
      fontSize: 9,
      color: palette.fmObjColor,
      background: palette.fmObjBg,
    };
  }

  // String (default)
  return { text: String(value), fontSize: 10 };
}

function convertFrontmatter(node: ProsemirrorNode, ctx: ConvertContext): Content {
  const palette = ctx.palette;
  const text = node.textContent || '';
  if (!text.trim()) return { text: '' };

  // Try to parse as YAML key-value pairs
  try {
    const data = yaml.load(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const rows: any[][] = [];
      for (const [key, value] of Object.entries(data)) {
        const formattedValue = formatFmValue(value, palette);
        rows.push([
          { text: key, fontSize: 9, color: palette.textMuted },
          Array.isArray(formattedValue)
            ? { text: formattedValue }
            : formattedValue,
        ]);
      }
      if (rows.length > 0) {
        return {
          table: {
            widths: [70, '*'],
            body: [
              [{ text: 'FRONTMATTER', colSpan: 2, bold: true, fontSize: 9, color: palette.frontmatterLabel }, {}],
              ...rows,
            ],
          },
          layout: frontmatterLayout(palette),
          margin: [0, 0, 0, 12] as [number, number, number, number],
        } as any;
      }
    }
  } catch {
    // fallback
  }

  // Fallback: show raw YAML
  return {
    table: {
      widths: ['*'],
      body: [[{
        stack: [
          { text: 'FRONTMATTER', bold: true, fontSize: 9, color: palette.frontmatterLabel, margin: [0, 0, 0, 4] as any },
          { text: text, font: 'RobotoMono', fontSize: 9, preserveLeadingSpaces: true },
        ],
      }]],
    },
    layout: frontmatterLayout(palette),
    margin: [0, 0, 0, 12] as [number, number, number, number],
  } as any;
}

// ─── Inline Content Converter ────────────────────────────────────────────

/**
 * Convert inline content (text nodes + marks + inline nodes) of a block node.
 */
export function convertInlineContent(node: ProsemirrorNode, ctx: ConvertContext): any[] {
  const result: any[] = [];

  node.forEach((child) => {
    if (child.isText) {
      const textObj = applyMarks(child.text || '', child.marks, ctx.palette);
      // Split text into emoji/non-emoji segments for font switching
      const segments = wrapWithEmojiFont(textObj);
      result.push(...segments);
    } else {
      // Inline node (not text)
      const inlineResult = convertInlineNode(child, ctx);
      if (inlineResult !== null) {
        result.push(inlineResult);
      }
    }
  });

  return result;
}

/**
 * Convert inline nodes (non-text nodes that appear inline).
 */
function convertInlineNode(node: ProsemirrorNode, ctx: ConvertContext): any {
  switch (node.type.name) {
    case 'hard_break':
      return '\n';

    case 'footnote_ref':
      return {
        text: `[${node.attrs.label}]`,
        color: ctx.palette.link,
        sup: true,
        id: `footnote-ref-${node.attrs.label}`,
        linkToDestination: `footnote-${node.attrs.label}`,
      } as any;

    case 'math_inline': {
      const tex = (node.textContent || '').trim();
      // Inline math rendered as styled text (pdfmake can't inline images in text arrays)
      return {
        text: `\u2009${tex}\u2009`,
        font: 'RobotoMono',
        fontSize: 9,
        background: ctx.palette.mathBg,
        color: ctx.palette.mathColor,
        italics: true,
      };
    }

    case 'image': {
      const imgSrc = node.attrs.src || '';
      const imgOrigSrc = node.attrs.originalSrc || '';
      let imgBase64 = ctx.imageMap.get(imgSrc);
      if (!imgBase64 && imgOrigSrc) imgBase64 = ctx.imageMap.get(imgOrigSrc);
      if (imgBase64) {
        return {
          image: imgBase64,
          fit: [Math.min(node.attrs.width || 200, CONTENT_WIDTH), 400],
        };
      }
      return {
        text: node.attrs.alt ? `[${node.attrs.alt}]` : '[Image]',
        color: ctx.palette.textFaint,
        italics: true,
      };
    }

    case 'html_inline':
      return {
        text: node.attrs.html || '',
        fontSize: 9,
        color: ctx.palette.textMuted,
      };

    case 'video': {
      const vAlt = node.attrs.alt || node.attrs.title || '';
      return {
        text: vAlt ? `[Video: ${vAlt}]` : '[Video]',
        color: ctx.palette.textFaint,
        italics: true,
      };
    }

    case 'audio': {
      const aAlt = node.attrs.alt || node.attrs.title || '';
      return {
        text: aAlt ? `[Audio: ${aAlt}]` : '[Audio]',
        color: ctx.palette.textFaint,
        italics: true,
      };
    }

    default:
      return null;
  }
}

/**
 * Apply ProseMirror marks to a text string, returning a pdfmake text object.
 */
function applyMarks(text: string, marks: readonly Mark[], palette: PdfPalette): any {
  if (!marks || marks.length === 0) {
    return text;
  }

  const result: any = { text };

  for (const mark of marks) {
    switch (mark.type.name) {
      case 'strong':
        result.bold = true;
        break;
      case 'em':
        result.italics = true;
        break;
      case 'underline':
        result.decoration = addDecoration(result.decoration, 'underline');
        break;
      case 'strikethrough':
        result.decoration = addDecoration(result.decoration, 'lineThrough');
        break;
      case 'code_inline':
        result.font = 'RobotoMono';
        result.fontSize = 10;
        result.background = palette.codeInlineBg;
        result.color = palette.codeInlineColor;
        // Simulate horizontal padding with thin spaces
        result.text = `\u2009${text}\u2009`;
        break;
      case 'highlight': {
        // pdfmake doesn't support alpha in hex colors — use solid light colors
        const hlColor = mark.attrs.color;
        result.background = hlColor ? lightenHex(hlColor, 0.35) : palette.markBg;
        break;
      }
      case 'link': {
        const href = mark.attrs.href || '';
        if (href.startsWith('#')) {
          // Internal link -> use linkToDestination
          result.linkToDestination = href.slice(1);
        } else {
          result.link = href;
        }
        result.color = palette.link;
        result.decoration = addDecoration(result.decoration, 'underline');
      }
        break;
      case 'diff_add':
        result.color = palette.diffAddColor;
        result.background = palette.diffAddBg;
        break;
      case 'diff_del':
        result.color = palette.diffDelColor;
        result.decoration = addDecoration(result.decoration, 'lineThrough');
        result.background = palette.diffDelBg;
        break;
      case 'html_tag': {
        const tag = mark.attrs.tag;
        if (tag === 'kbd') {
          result.text = `\u00A0${text}\u00A0`;
          result.font = 'RobotoMono';
          result.fontSize = 9;
          result.background = palette.kbdBg;
          result.bold = true;
        } else if (tag === 'sub') {
          (result as any).sub = true;
          result.fontSize = 14; // pdfmake reduces sub to ~58%, so 14*0.58~8.1pt; 14 < natural line height 15.4pt
        } else if (tag === 'sup') {
          (result as any).sup = true;
          result.fontSize = 14; // pdfmake reduces sup to ~58%, so 14*0.58~8.1pt; 14 < natural line height 15.4pt
        } else if (tag === 'small') {
          result.fontSize = 9;
        } else if (tag === 'var' || tag === 'samp') {
          result.font = 'RobotoMono';
          result.italics = true;
        } else if (tag === 'abbr') {
          result.decoration = addDecoration(result.decoration, 'underline');
          result.decorationStyle = 'dotted';
        } else if (tag === 'ruby') {
          // Ruby text — show as-is (annotation follows in rt)
        } else if (tag === 'rt') {
          result.fontSize = 7;
          result.color = palette.textMuted;
        } else if (tag === 'rp') {
          result.fontSize = 7;
          result.color = palette.textMuted;
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Helper to combine multiple decoration values.
 * pdfmake supports either a single string or an array.
 */
function addDecoration(existing: any, newDeco: string): any {
  if (!existing) return newDeco;
  if (typeof existing === 'string') {
    if (existing === newDeco) return existing;
    return [existing, newDeco];
  }
  if (Array.isArray(existing)) {
    if (existing.includes(newDeco)) return existing;
    return [...existing, newDeco];
  }
  return newDeco;
}

// ─── Table Width Calculation ──────────────────────────────────────────────

/** Cell padding (6pt left + 6pt right) */
const TABLE_CELL_PAD = 12;
/** Approximate character width at 11pt Roboto (generous for Cyrillic/wide glyphs) */
const CHAR_WIDTH_11 = 6.2;

interface TableWidthResult {
  widths: (string | number)[];
  scaled: boolean;
  landscape: boolean;
  fontSize?: number;
}

/**
 * Estimate total table width at natural size (auto widths).
 * Returns { overhead, totalEstimated, maxLengths, maxWordLens }.
 */
function estimateTableMetrics(rows: any[][], columnCount: number) {
  const maxLengths = new Array(columnCount).fill(1);
  const maxWordLens = new Array(columnCount).fill(1);

  for (const row of rows) {
    for (let i = 0; i < row.length && i < columnCount; i++) {
      const cell = row[i];
      if (cell && cell.colSpan && cell.colSpan > 1) continue;
      const text = extractCellText(cell);
      maxLengths[i] = Math.max(maxLengths[i], text.length);
      const longestWord = text.split(/\s+/).reduce(
        (max, w) => Math.max(max, w.length), 0,
      );
      maxWordLens[i] = Math.max(maxWordLens[i], longestWord);
    }
  }

  const totalPadding = columnCount * TABLE_CELL_PAD;
  const totalBorders = (columnCount + 1) * 0.5;
  const overhead = totalPadding + totalBorders;
  const totalContent = maxLengths.reduce((sum, len) => sum + len * CHAR_WIDTH_11, 0);

  return { overhead, totalEstimated: totalContent + overhead, maxLengths, maxWordLens };
}

/**
 * Calculate column widths for a given available page width.
 * Returns null if table fits naturally (use 'auto'), otherwise returns fixed widths.
 */
function fitTableToWidth(
  pageWidth: number,
  overhead: number,
  maxLengths: number[],
  maxWordLens: number[],
  columnCount: number,
): { widths: number[]; fontSize?: number } | null {
  const availableForContent = pageWidth - overhead;
  let charWidth = CHAR_WIDTH_11;

  // Minimum widths = longest word per column + 15% safety margin
  let minWidths = maxWordLens.map(len => len * charWidth * 1.15);
  let totalMinimums = minWidths.reduce((sum, w) => sum + w, 0);
  let fontSize: number | undefined;

  // If minimums don't fit, reduce font step by step down to 6pt
  if (totalMinimums > availableForContent) {
    for (const trySize of [10, 9, 8, 7, 6]) {
      fontSize = trySize;
      charWidth = CHAR_WIDTH_11 * trySize / 11;
      minWidths = maxWordLens.map(len => len * charWidth * 1.15);
      totalMinimums = minWidths.reduce((sum, w) => sum + w, 0);
      if (totalMinimums <= availableForContent) break;
    }
  } else if (columnCount >= 7) {
    fontSize = columnCount >= 10 ? 8 : 9;
  }

  // Distribute: minimum per column + surplus proportionally
  const surplus = Math.max(availableForContent - totalMinimums, 0);
  const extraNeeds = maxLengths.map((len, i) => Math.max(len * charWidth - minWidths[i], 0));
  const totalExtraNeeds = extraNeeds.reduce((sum, w) => sum + w, 0);

  const widths = minWidths.map((min, i) => {
    if (totalExtraNeeds > 0 && surplus > 0) {
      return Math.round(min + (extraNeeds[i] / totalExtraNeeds) * surplus);
    }
    return Math.round(min);
  });

  return { widths, fontSize };
}

/**
 * Calculate column widths for pdfmake tables.
 *
 * Strategy:
 * 1. If table fits portrait at natural size → 'auto', centered
 * 2. If table fits portrait with proportional scaling → fixed widths, portrait
 * 3. If table fits landscape at natural size → 'auto', landscape page
 * 4. If table fits landscape with scaling → fixed widths, landscape page
 * 5. Landscape + font reduction down to 6pt as last resort
 */
function calculateTableWidths(rows: any[][], columnCount: number): TableWidthResult {
  if (columnCount === 0) return { widths: [], scaled: false, landscape: false };

  const { overhead, totalEstimated, maxLengths, maxWordLens } = estimateTableMetrics(rows, columnCount);

  // 1. Fits portrait naturally
  if (totalEstimated <= CONTENT_WIDTH) {
    return { widths: Array(columnCount).fill('auto'), scaled: false, landscape: false };
  }

  // 2. Try portrait with proportional scaling (no font reduction needed if words fit)
  const portraitMinWidths = maxWordLens.map(len => len * CHAR_WIDTH_11 * 1.15);
  const portraitMinTotal = portraitMinWidths.reduce((sum, w) => sum + w, 0);
  if (portraitMinTotal <= CONTENT_WIDTH - overhead) {
    const result = fitTableToWidth(CONTENT_WIDTH, overhead, maxLengths, maxWordLens, columnCount)!;
    return { widths: result.widths, scaled: true, landscape: false, fontSize: result.fontSize };
  }

  // 3. Fits landscape naturally
  if (totalEstimated <= CONTENT_WIDTH_LANDSCAPE) {
    return { widths: Array(columnCount).fill('auto'), scaled: false, landscape: true };
  }

  // 4-5. Landscape with proportional scaling (+ font reduction if needed)
  const result = fitTableToWidth(CONTENT_WIDTH_LANDSCAPE, overhead, maxLengths, maxWordLens, columnCount)!;
  return { widths: result.widths, scaled: true, landscape: true, fontSize: result.fontSize };
}

/**
 * Extract full text from a pdfmake cell definition.
 */
function extractCellText(cell: any): string {
  if (!cell) return '';
  if (typeof cell === 'string') return cell;
  if (typeof cell.text === 'string') return cell.text;
  if (Array.isArray(cell.text)) {
    return cell.text.map((item: any) => {
      if (typeof item === 'string') return item;
      if (item && typeof item.text === 'string') return item.text;
      return '';
    }).join('');
  }
  if (cell.stack && Array.isArray(cell.stack)) {
    return cell.stack.map((item: any) => extractCellText(item)).join(' ');
  }
  return '';
}

// ─── Table Keyword Badges ─────────────────────────────────────────────────

type BadgeColor = 'green' | 'red' | 'gray';

const KW_LOWER: Record<string, BadgeColor> = {
  true: 'green', yes: 'green', да: 'green',
  false: 'red', no: 'red', нет: 'red',
  null: 'gray', 'n/a': 'gray', na: 'gray', none: 'gray',
};

const KW_EXACT: Record<string, BadgeColor> = {
  '—': 'gray', '-': 'gray', '--': 'gray',
};

function getTableKeywordColor(text: string): BadgeColor | null {
  return KW_EXACT[text] ?? KW_LOWER[text.toLowerCase()] ?? null;
}

/**
 * Apply keyword badge styling to pdfmake cell content.
 * Wraps the text with background color and colored text.
 */
function applyKeywordBadge(cellContent: any[], color: BadgeColor, palette: PdfPalette): void {
  const bgKey = `kw${color[0].toUpperCase()}${color.slice(1)}Bg` as keyof PdfPalette;
  const colorKey = `kw${color[0].toUpperCase()}${color.slice(1)}Color` as keyof PdfPalette;
  const bg = palette[bgKey] as string;
  const fg = palette[colorKey] as string;

  for (const item of cellContent) {
    if (!item || typeof item !== 'object') continue;
    // Paragraph: { text: [...], lineHeight, margin }
    if (item.text !== undefined) {
      applyBadgeToTextNode(item, bg, fg);
    }
    // Stack of paragraphs
    if (item.stack && Array.isArray(item.stack)) {
      for (const child of item.stack) {
        if (child && typeof child === 'object' && child.text !== undefined) {
          applyBadgeToTextNode(child, bg, fg);
        }
      }
    }
  }
}

function applyBadgeToTextNode(node: any, bg: string, fg: string): void {
  if (typeof node.text === 'string') {
    node.text = `\u2009${node.text.trim()}\u2009`;
    node.background = bg;
    node.color = fg;
    node.bold = true;
    node.fontSize = 10;
  } else if (Array.isArray(node.text)) {
    for (const seg of node.text) {
      if (typeof seg === 'string') {
        // Can't modify string in-place; replace in array
        const idx = node.text.indexOf(seg);
        node.text[idx] = {
          text: `\u2009${seg.trim()}\u2009`,
          background: bg,
          color: fg,
          bold: true,
          fontSize: 10,
        };
      } else if (seg && typeof seg === 'object' && typeof seg.text === 'string') {
        seg.text = `\u2009${seg.text.trim()}\u2009`;
        seg.background = bg;
        seg.color = fg;
        seg.bold = true;
        seg.fontSize = 10;
      }
    }
  }
}
