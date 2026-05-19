/**
 * PdfStyles — styles, fonts, and table layouts for pdfmake PDF export.
 */

import type { PdfPalette } from './PdfPalette';

export function getPageConfig(palette: PdfPalette) {
  return {
    pageSize: 'A4' as const,
    pageOrientation: 'portrait' as const,
    pageMargins: [40, 25, 40, 50] as [number, number, number, number],
    defaultStyle: {
      font: 'Roboto',
      fontSize: 11,
      lineHeight: 1.25,
      color: palette.text,
    },
  };
}

/** Content width = A4 width (595.28) - left margin (40) - right margin (40) */
export const CONTENT_WIDTH = 515;
/** Landscape content width = A4 height (841.89) - left margin (40) - right margin (40) */
export const CONTENT_WIDTH_LANDSCAPE = 761;

export const HEADING_STYLES: Record<number, { fontSize: number; margin: [number, number, number, number] }> = {
  1: { fontSize: 24, margin: [0, 20, 0, 8] },
  2: { fontSize: 20, margin: [0, 16, 0, 6] },
  3: { fontSize: 16, margin: [0, 14, 0, 5] },
  4: { fontSize: 14, margin: [0, 12, 0, 4] },
  5: { fontSize: 12, margin: [0, 10, 0, 4] },
  6: { fontSize: 11, margin: [0, 10, 0, 4] },
};

export const NOTICE_COLORS: Record<string, string> = {
  note: '#3794ff',
  tip: '#2ea043',
  important: '#8957e5',
  caution: '#cca700',
  warning: '#f85149',
  info: '#3794ff',
  success: '#2ea043',
  error: '#f85149',
};

export const NOTICE_ICONS: Record<string, string> = {
  note: 'i',
  tip: '*',
  important: '!',
  caution: '!',
  warning: '!!',
  info: 'i',
  success: '+',
  error: 'x',
};

export const CHECKBOX_MARKERS: Record<string, string> = {
  false: '☐',
  true: '☑',
  inapplicable: '☒',
};

/** pdfmake table layout for markdown tables */
export function tableLayout(palette: PdfPalette) {
  return {
    hLineWidth() {
      return 0.5;
    },
    vLineWidth() {
      return 0.5;
    },
    hLineColor() {
      return palette.tableBorder;
    },
    vLineColor() {
      return palette.tableBorder;
    },
    paddingLeft() {
      return 6;
    },
    paddingRight() {
      return 6;
    },
    paddingTop() {
      return 4;
    },
    paddingBottom() {
      return 4;
    },
    fillColor(rowIndex: number) {
      return rowIndex === 0 ? palette.tableHeaderFill : null;
    },
  };
}

/** pdfmake table layout for code blocks */
export function codeBlockLayout(palette: PdfPalette) {
  return {
    hLineWidth() {
      return 0.3;
    },
    vLineWidth() {
      return 0.3;
    },
    hLineColor() {
      return palette.codeBorder;
    },
    vLineColor() {
      return palette.codeBorder;
    },
    paddingLeft() {
      return 10;
    },
    paddingRight() {
      return 10;
    },
    paddingTop() {
      return 8;
    },
    paddingBottom() {
      return 8;
    },
    fillColor() {
      return palette.codeFill;
    },
  };
}

/** pdfmake table layout for blockquotes (left border only) */
export function blockquoteLayout(palette: PdfPalette) {
  return {
    hLineWidth() {
      return 0;
    },
    vLineWidth(i: number) {
      return i === 0 ? 3 : 0;
    },
    hLineColor() {
      return palette.blockquoteBorderBg;
    },
    vLineColor() {
      return palette.blockquoteBorder;
    },
    paddingLeft() {
      return 14;
    },
    paddingRight() {
      return 12;
    },
    paddingTop() {
      return 6;
    },
    paddingBottom() {
      return 1;
    },
    fillColor() {
      return palette.blockquoteFill;
    },
  };
}

/** pdfmake table layout for notice/callout blocks (colored left border) */
export function noticeLayout(color: string, bgColor: string, palette: PdfPalette) {
  return {
    hLineWidth() {
      return 0;
    },
    vLineWidth(i: number) {
      return i === 0 ? 4 : 0;
    },
    hLineColor() {
      return palette.pageBackground;
    },
    vLineColor() {
      return color;
    },
    paddingLeft() {
      return 14;
    },
    paddingRight() {
      return 12;
    },
    paddingTop() {
      return 8;
    },
    paddingBottom() {
      return 6;
    },
    fillColor() {
      return bgColor;
    },
  };
}

/** pdfmake table layout for details/expand blocks */
export function detailsLayout(palette: PdfPalette) {
  return {
    hLineWidth(i: number, node: any) {
      return i === 0 || i === node.table.body.length ? 0.5 : 0.5;
    },
    vLineWidth() {
      return 0.5;
    },
    hLineColor() {
      return palette.detailsBorder;
    },
    vLineColor() {
      return palette.detailsBorder;
    },
    paddingLeft() {
      return 10;
    },
    paddingRight() {
      return 10;
    },
    paddingTop() {
      return 6;
    },
    paddingBottom() {
      return 6;
    },
    fillColor(rowIndex: number) {
      return rowIndex === 0 ? palette.detailsHeaderFill : null;
    },
  };
}

/** pdfmake table layout for frontmatter key-value display */
export function frontmatterLayout(palette: PdfPalette) {
  return {
    hLineWidth(i: number, node: any) {
      return i === 0 || i === node.table.body.length ? 0.5 : 0.3;
    },
    vLineWidth(i: number, node: any) {
      return i === 0 || i === node.table.widths.length ? 0.5 : 0;
    },
    hLineColor() {
      return palette.frontmatterBorder;
    },
    vLineColor() {
      return palette.frontmatterBorder;
    },
    paddingLeft() {
      return 8;
    },
    paddingRight() {
      return 8;
    },
    paddingTop() {
      return 5;
    },
    paddingBottom() {
      return 5;
    },
    fillColor(rowIndex: number) {
      return rowIndex % 2 === 0 ? null : palette.frontmatterStripeFill;
    },
  };
}

/** pdfmake table layout for comment blocks */
export function commentLayout(palette: PdfPalette) {
  return {
    hLineWidth() {
      return 0.5;
    },
    vLineWidth() {
      return 0.5;
    },
    hLineColor() {
      return palette.commentBorder;
    },
    vLineColor() {
      return palette.commentBorder;
    },
    hLineStyle() {
      return { dash: { length: 3, space: 2 } };
    },
    vLineStyle() {
      return { dash: { length: 3, space: 2 } };
    },
    paddingLeft() {
      return 8;
    },
    paddingRight() {
      return 8;
    },
    paddingTop() {
      return 4;
    },
    paddingBottom() {
      return 4;
    },
  };
}
