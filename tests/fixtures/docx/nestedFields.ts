import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const begin = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>';
const separate = '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
const code = (value: string) => `<w:r><w:instrText>${value}</w:instrText></w:r>`;
const entry = (text: string, page: number) => `${begin}${code('HYPERLINK')}${separate}<w:r><w:t>${text}</w:t><w:tab/></w:r>${begin}${code('PAGEREF')}${separate}<w:r><w:t>${page}</w:t></w:r>${end}${end}`;
const tocParagraph = (inner: string) => `<w:p><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="7200"/></w:tabs></w:pPr>${inner}</w:p>`;

/** Minimal non-sensitive cover and cross-paragraph nested TOC, using an existing valid DOCX envelope. */
export async function nestedFieldsDocx(repoRoot: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await readFile(path.join(repoRoot, 'tests/fixtures/preview/sample.docx')));
  const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:sectPr><w:type w:val="continuous"/></w:sectPr></w:pPr><w:r><w:t>Fixture cover</w:t></w:r></w:p>
${tocParagraph(`${begin}${code('TOC')}${separate}${entry('First heading', 1)}`)}
${tocParagraph(entry('Second heading', 2))}<w:p>${end}</w:p><w:sectPr/></w:body></w:document>`;
  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}
