import { describe, expect, test } from 'vitest';
import { parseXml } from './xmlParser';
import { parseParagraphContents } from './paragraphParser/content';

const begin = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>';
const separate = '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
const code = (text: string) => `<w:r><w:instrText>${text}</w:instrText></w:r>`;
const text = (value: string) => `<w:r><w:t>${value}</w:t></w:r>`;
const parse = (content: string) => {
  const xml = `<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${content}</w:p>`;
  return parseParagraphContents(parseXml(xml).elements![0], null, null, null, null, null);
};

describe('complex field parsing', () => {
  test('nested field retains the outer result and all field markers', () => {
    const parsed = parse(`${begin}${code('TOC')}${separate}${text('Heading')}${begin}${code('PAGE')}${separate}${text('42')}${end}${end}`);
    const value = JSON.stringify(parsed);
    expect(value).toContain('Heading');
    expect(value).toContain('42');
    expect((value.match(/"charType":"begin"/g) ?? [])).toHaveLength(2);
    expect((value.match(/"charType":"end"/g) ?? [])).toHaveLength(2);
  });
  test('preserves incomplete cross-paragraph markers without discarding visible text', () => {
    const first = JSON.stringify(parse(`${begin}${code('TOC')}${separate}${text('Heading')}`));
    const last = JSON.stringify(parse(`${text('Last')}${end}`));
    expect(first).toContain('Heading'); expect(first).toContain('"charType":"begin"');
    expect(last).toContain('Last'); expect(last).toContain('"charType":"end"');
  });
  test('keeps ordinary fields and adjacent regular text in their existing representation', () => {
    const parsed = parse(`${text('Before')}${begin}${code('PAGE')}${separate}${text('3')}${end}${text('After')}`);
    expect(parsed.map((item) => item.type)).toEqual(['run', 'complexField', 'run']);
    expect(JSON.stringify(parsed)).toContain('Before'); expect(JSON.stringify(parsed)).toContain('After');
  });
});
