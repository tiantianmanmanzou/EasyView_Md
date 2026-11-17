import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const fangsong = '<w:rFonts w:ascii="仿宋_GB2312" w:hAnsi="宋体" w:eastAsia="宋体"/>';
const sym = (char: string) => `<w:r><w:rPr>${fangsong}</w:rPr><w:sym w:font="Wingdings 2" w:char="${char}"/></w:r>`;

/** Chinese form conventions: Wingdings 2 checkboxes, highlight vs. shading, GB-font blanks between brackets. */
export async function gbFormDocx(repoRoot: string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await readFile(path.join(repoRoot, 'tests/fixtures/preview/sample.docx')));
  const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p>${sym('0052')}<w:r><w:t xml:space="preserve"> Option one </w:t></w:r>${sym('00A3')}<w:r><w:t xml:space="preserve"> Option two</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:t>Marked text</w:t></w:r><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:r><w:rPr><w:shd w:val="clear" w:color="auto" w:fill="CCE8CF"/></w:rPr><w:t>Shaded text</w:t></w:r></w:p>
<w:p><w:r><w:rPr>${fangsong}</w:rPr><w:t xml:space="preserve">Signature: [                    ]</w:t></w:r></w:p>
<w:sectPr/></w:body></w:document>`;
  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}
