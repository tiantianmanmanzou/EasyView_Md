import { describe, test, expect } from 'bun:test';
import { resolveFontFamily, getGoogleFontEquivalent } from './fontResolver';

describe('fontResolver — native CJK theme typefaces map to matched Noto webfonts', () => {
  // The names `applyThemeFontLang` writes into the empty `<a:ea>` slot are the
  // native typeface names from `theme1.xml`, not the romanized ones. Each must
  // resolve to a loadable Google (Noto) webfont so measurement and rendering
  // use the same font as Japanese already does.
  const cases: Array<[string, string]> = [
    // Simplified Chinese
    ['宋体', 'Noto Serif SC'],
    ['黑体', 'Noto Sans SC'],
    ['微软雅黑', 'Noto Sans SC'],
    ['等线', 'Noto Sans SC'],
    ['仿宋', 'Noto Serif SC'],
    ['楷体', 'Noto Serif SC'],
    // Traditional Chinese
    ['新細明體', 'Noto Serif TC'],
    ['細明體', 'Noto Serif TC'],
    ['微軟正黑體', 'Noto Sans TC'],
    ['標楷體', 'Noto Serif TC'],
    // Korean
    ['맑은 고딕', 'Noto Sans KR'],
    ['굴림', 'Noto Sans KR'],
    ['돋움', 'Noto Sans KR'],
    ['바탕', 'Noto Serif KR'],
    ['궁서', 'Noto Serif KR'],
  ];

  for (const [name, font] of cases) {
    test(`${name} → ${font}`, () => {
      const resolved = resolveFontFamily(name);
      expect(resolved.googleFont).toBe(font);
      expect(resolved.hasGoogleEquivalent).toBe(true);
      expect(getGoogleFontEquivalent(name)).toBe(font);
    });
  }
});

describe('fontResolver — Chinese GB fonts', () => {
  test('_GB2312 names resolve to their family and keep the original name first', () => {
    const resolved = resolveFontFamily('仿宋_GB2312');
    expect(resolved.cssFallback).toBe('仿宋_GB2312, FangSong, 仿宋, "Noto Serif SC", serif');
    expect(resolved.halfWidthAscii).toBe(true);
    expect(resolveFontFamily('楷体_GB2312').googleFont).toBe('Noto Serif SC');
  });

  test('only the GB fonts set ASCII half an em wide', () => {
    expect(['宋体', 'SimSun', '黑体', '仿宋', 'KaiTi'].map((name) => resolveFontFamily(name).halfWidthAscii)).toEqual([true, true, true, true, true]);
    expect(['微软雅黑', '等线', 'Calibri', 'Times New Roman'].map((name) => resolveFontFamily(name).halfWidthAscii)).toEqual([false, false, false, false]);
  });
});
