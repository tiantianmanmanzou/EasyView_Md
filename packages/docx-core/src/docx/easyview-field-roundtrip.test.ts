import { describe, expect, test } from 'vitest';
import { parseDocumentBody } from './documentParser';
import { serializeDocument } from './serializer/documentSerializer';
import { toProseDoc } from '../prosemirror/conversion/toProseDoc';
import { fromProseDoc } from '../prosemirror/conversion/fromProseDoc';
import type { Document } from '../types/document';

const begin = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>';
const separate = '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
const instruction = (value: string) => `<w:r><w:instrText>${value}</w:instrText></w:r>`;
const entry = (title: string, page: number) => `${begin}${instruction('HYPERLINK')} ${separate}<w:r><w:t>${title}</w:t><w:tab/></w:r>${begin}${instruction('PAGEREF')}${separate}<w:r><w:t>${page}</w:t></w:r>${end}${end}`;
const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>${begin}${instruction('TOC')}${separate}${entry('Heading one',1)}</w:p><w:p>${entry('Heading two',2)}</w:p><w:p>${end}</w:p></w:body></w:document>`;

describe('nested fields spanning paragraphs', () => {
  test('keeps visible text, tabs and field structure through editor conversion and serialization', () => {
    const body = parseDocumentBody(xml);
    const original = { package: { document: body } } as Document;
    const pm = toProseDoc(original);
    const saved = fromProseDoc(pm, original);
    const savedXml = serializeDocument(saved);
    const reparsed = parseDocumentBody(savedXml);
    expect(JSON.stringify(reparsed.content)).toContain('Heading one');
    expect(JSON.stringify(reparsed.content)).toContain('Heading two');
    expect((savedXml.match(/w:fldCharType="begin"/g) ?? []).length).toBe(5);
    expect((savedXml.match(/w:fldCharType="end"/g) ?? []).length).toBe(5);
    expect((savedXml.match(/<w:tab\s*\/>/g) ?? []).length).toBe(2);
    expect((savedXml.match(/HYPERLINK/g) ?? []).length).toBe(2);
    expect((savedXml.match(/PAGEREF/g) ?? []).length).toBe(2);
    expect(savedXml).toContain('TOC');
  });
});
