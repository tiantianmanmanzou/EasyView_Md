/**
 * Append x-spreadsheet cell styles into an existing xl/styles.xml without ExcelJS.
 */

import type { XsCellStyle } from './xSpreadsheetTypes';

const element = (tag: string) =>
  `<${tag}\\b(?:[^>]*?\\/>|[^>]*?[^/>]>[\\s\\S]*?<\\/${tag}>|>[\\s\\S]*?<\\/${tag}>)`;
const tags = (xml: string, tag: string) => [...xml.matchAll(new RegExp(element(tag), 'g'))].map((m) => m[0]);
const attr = (xml: string, key: string) => new RegExp(`\\b${key}="([^"]*)"`).exec(xml)?.[1] ?? '';
const section = (xml: string, name: string) => new RegExp(element(name)).exec(xml)?.[0] ?? '';

function replaceSection(xml: string, name: string, value: string, before = '</styleSheet>'): string {
  const old = section(xml, name);
  return old ? xml.replace(old, value) : xml.replace(before, `${value}${before}`);
}

const XS_NUMBER_FORMATS: Record<string, string> = {
  normal: 'General',
  text: '@',
  number: '#,##0.00',
  percent: '0.00%',
  rmb: '"￥"#,##0.00',
  usd: '"$"#,##0.00',
  eur: '"€"#,##0.00',
  date: 'yyyy-mm-dd',
  time: 'hh:mm:ss',
  datetime: 'yyyy-mm-dd hh:mm:ss',
  duration: '[h]:mm:ss',
};

function cssToArgb(css: string): string {
  let hex = css.replace('#', '').trim();
  if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = hex.replace(/./g, (ch) => ch + ch);
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `FF${hex.toUpperCase()}`;
  if (/^[0-9a-fA-F]{8}$/.test(hex)) return hex.toUpperCase();
  return 'FF000000';
}

function encodeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fontXml(style: XsCellStyle): string {
  const parts: string[] = ['<font>'];
  if (style.font?.bold) parts.push('<b/>');
  if (style.font?.italic) parts.push('<i/>');
  if (style.strike) parts.push('<strike/>');
  if (style.underline) parts.push('<u/>');
  if (typeof style.font?.size === 'number') parts.push(`<sz val="${style.font.size}"/>`);
  if (style.color) parts.push(`<color rgb="${cssToArgb(style.color)}"/>`);
  if (typeof style.font?.name === 'string' && style.font.name) {
    parts.push(`<name val="${encodeXmlText(style.font.name)}"/>`);
  }
  parts.push('</font>');
  return parts.join('');
}

function fillXml(style: XsCellStyle): string {
  if (!style.bgcolor) return '<fill><patternFill patternType="none"/></fill>';
  return `<fill><patternFill patternType="solid"><fgColor rgb="${cssToArgb(style.bgcolor)}"/><bgColor indexed="64"/></patternFill></fill>`;
}

function borderXml(style: XsCellStyle): string {
  const border = style.border;
  if (!border) return '<border><left/><right/><top/><bottom/><diagonal/></border>';
  const side = (name: 'left' | 'right' | 'top' | 'bottom') => {
    const edge = border[name];
    if (!edge?.[0]) return `<${name}/>`;
    const line = edge[0];
    const color = cssToArgb(edge[1] || '#000000');
    return `<${name} style="${line}"><color rgb="${color}"/></${name}>`;
  };
  return `<border>${side('left')}${side('right')}${side('top')}${side('bottom')}<diagonal/></border>`;
}

function alignmentXml(style: XsCellStyle): string {
  const attrs: string[] = [];
  if (style.align) attrs.push(`horizontal="${style.align}"`);
  if (style.valign) {
    const v = style.valign === 'middle' ? 'center' : style.valign;
    attrs.push(`vertical="${v}"`);
  }
  if (style.textwrap) attrs.push('wrapText="1"');
  return attrs.length ? `<alignment ${attrs.join(' ')}/>` : '';
}

function upsertIndexed(
  existing: string[],
  value: string,
): { index: number; list: string[] } {
  const found = existing.indexOf(value);
  if (found >= 0) return { index: found, list: existing };
  return { index: existing.length, list: [...existing, value] };
}

/**
 * Ensure `style` exists as a cellXf in styles.xml. Returns the updated XML and xf index.
 * `preserveNumFmtId` mirrors ExcelJS applyChanges: keep the prior cell's number format
 * when the editor style does not set one.
 */
export function appendXsStyle(
  stylesXml: string,
  style: XsCellStyle,
  preserveNumFmtId = 0,
): { xml: string; xfIndex: number } {
  let xml = stylesXml;

  let numFmtId = preserveNumFmtId || 0;
  if (style.format && style.format in XS_NUMBER_FORMATS) {
    const code = XS_NUMBER_FORMATS[style.format];
    if (code === 'General') {
      numFmtId = 0;
    } else {
      const numFmts = tags(section(xml, 'numFmts') || '<numFmts count="0"/>', 'numFmt');
      const found = numFmts.find((entry) => attr(entry, 'formatCode') === code);
      if (found) {
        numFmtId = Number(attr(found, 'numFmtId'));
      } else {
        numFmtId = Math.max(164, ...numFmts.map((entry) => Number(attr(entry, 'numFmtId')) || 0)) + 1;
        const entry = `<numFmt numFmtId="${numFmtId}" formatCode="${encodeXmlText(code)}"/>`;
        const next = [...numFmts, entry];
        xml = replaceSection(xml, 'numFmts', `<numFmts count="${next.length}">${next.join('')}</numFmts>`, '<fonts');
      }
    }
  }

  const fonts = tags(section(xml, 'fonts'), 'font');
  const fills = tags(section(xml, 'fills'), 'fill');
  const borders = tags(section(xml, 'borders'), 'border');
  const cellXfs = tags(section(xml, 'cellXfs'), 'xf');

  const needsFont = !!(style.font || style.color || style.strike || style.underline);
  const needsFill = !!style.bgcolor;
  const needsBorder = !!style.border;
  const needsAlign = !!(style.align || style.valign || style.textwrap);

  const font = needsFont ? upsertIndexed(fonts, fontXml(style)) : { index: 0, list: fonts };
  const fill = needsFill ? upsertIndexed(fills, fillXml(style)) : { index: 0, list: fills };
  const border = needsBorder ? upsertIndexed(borders, borderXml(style)) : { index: 0, list: borders };

  if (font.list !== fonts) {
    xml = replaceSection(xml, 'fonts', `<fonts count="${font.list.length}">${font.list.join('')}</fonts>`);
  }
  if (fill.list !== fills) {
    xml = replaceSection(xml, 'fills', `<fills count="${fill.list.length}">${fill.list.join('')}</fills>`);
  }
  if (border.list !== borders) {
    xml = replaceSection(xml, 'borders', `<borders count="${border.list.length}">${border.list.join('')}</borders>`);
  }

  const applyBits = [
    needsFont ? ' applyFont="1"' : '',
    needsFill ? ' applyFill="1"' : '',
    needsBorder ? ' applyBorder="1"' : '',
    needsAlign ? ' applyAlignment="1"' : '',
    numFmtId ? ' applyNumberFormat="1"' : '',
  ].join('');
  const align = alignmentXml(style);
  const xf = `<xf numFmtId="${numFmtId}" fontId="${font.index}" fillId="${fill.index}" borderId="${border.index}" xfId="0"${applyBits}>${align}</xf>`;

  const xfUpsert = upsertIndexed(cellXfs, xf);
  if (xfUpsert.list !== cellXfs) {
    xml = replaceSection(
      xml,
      'cellXfs',
      `<cellXfs count="${xfUpsert.list.length}">${xfUpsert.list.join('')}</cellXfs>`,
    );
  }
  return { xml, xfIndex: xfUpsert.index };
}

/** Read numFmtId from an existing cellXf (0 when missing). */
export function cellXfNumFmtId(stylesXml: string, xfIndex: number | undefined): number {
  if (xfIndex === undefined || !Number.isFinite(xfIndex)) return 0;
  const xfs = tags(section(stylesXml, 'cellXfs'), 'xf');
  return Number(attr(xfs[xfIndex] ?? '', 'numFmtId') || 0);
}
