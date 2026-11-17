/**
 * WMF/EMF equation previews → SVG display conversion.
 *
 * Equation Editor / Kingsoft OLE objects (`Equation.KSEE3`) ship placeable WMF
 * previews. Browsers cannot paint `image/x-wmf`, so we convert to SVG and repair
 * GBK mojibake left when ExtTextOut omits a dx lead-byte map.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  displayDataUrlForMedia,
  isMetafileMime,
  metafileToSvgDataUrl,
  repairGbkMojibakeText,
  repairSvgGbkMojibake,
} from '../metafileDisplay';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../test-fixtures/equation-ole-preview.wmf'
);

describe('repairGbkMojibakeText', () => {
  test('re-decodes Latin-1 mojibake into CJK', () => {
    expect(repairGbkMojibakeText('ÄÉ¹ÜÒ»ÖÂµÄÊý¾Ý×ÊÔ´£¨')).toBe('纳管一致的数据资源（');
    expect(repairGbkMojibakeText('Êý¹ÜÄÉ¹ÜµÄ')).toBe('数管纳管的');
  });

  test('leaves ASCII and single Symbol glyphs alone', () => {
    expect(repairGbkMojibakeText('SOMP')).toBe('SOMP');
    expect(repairGbkMojibakeText('100')).toBe('100');
    expect(repairGbkMojibakeText('×')).toBe('×');
  });
});

describe('repairSvgGbkMojibake', () => {
  test('fixes text nodes inside SVG markup', () => {
    const svg = `<svg><text>ÄÉ¹Ü</text><text>SOMP</text></svg>`;
    expect(repairSvgGbkMojibake(svg)).toBe(`<svg><text>纳管</text><text>SOMP</text></svg>`);
  });
});

describe('isMetafileMime', () => {
  test('recognizes wmf/emf by mime or extension', () => {
    expect(isMetafileMime('image/x-wmf')).toBe(true);
    expect(isMetafileMime('image/x-emf')).toBe(true);
    expect(isMetafileMime('application/octet-stream', 'word/media/image5.wmf')).toBe(true);
    expect(isMetafileMime('image/png', 'word/media/image1.png')).toBe(false);
  });
});

describe('metafileToSvgDataUrl', () => {
  test('converts a placeable equation WMF to an SVG data URL with CJK text', () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const url = metafileToSvgDataUrl(bytes);
    expect(url).toMatch(/^data:image\/svg\+xml;base64,/);

    const b64 = url!.slice('data:image/svg+xml;base64,'.length);
    const svg = Buffer.from(b64, 'base64').toString('utf8');
    expect(svg).toContain('<svg');
    expect(svg).toMatch(/纳管/);
    expect(svg).toMatch(/SMC|SOMP|100/);

    expect(displayDataUrlForMedia(bytes.buffer, 'image/x-wmf', 'word/media/image5.wmf')).toBe(url);
  });
});
