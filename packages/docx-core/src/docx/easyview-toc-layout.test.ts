import { describe, expect, test } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { parseDocumentBody } from './documentParser';
import { serializeDocument } from './serializer/documentSerializer';
import { toProseDoc } from '../prosemirror/conversion/toProseDoc';
import { fromProseDoc } from '../prosemirror/conversion/fromProseDoc';
import { toFlowBlocks } from '../layout-bridge/toFlowBlocks';
import { layoutDocument } from '../layout-engine';
import type { Document } from '../types/document';
import type { FlowBlock, ParagraphBlock } from '../layout-engine/types';
import { makeLine, makeLayoutOptions, makeParagraphMeasure } from '../layout-engine/integration/helpers';

const begin = '<w:r><w:fldChar w:fldCharType="begin"/></w:r>';
const separate = '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
const instruction = (value: string) => `<w:r><w:instrText>${value}</w:instrText></w:r>`;
const text = (value: string) => `<w:r><w:t>${value}</w:t></w:r>`;
const entry = (title: string, page: number) =>
  `${begin}${instruction('HYPERLINK')}${separate}<w:r><w:t>${title}</w:t><w:tab/></w:r>${begin}${instruction('PAGEREF')}${separate}${text(String(page))}${end}${end}`;
const tocTabs = '<w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="7200"/></w:tabs></w:pPr>';
const documentXml = (body: string) =>
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
const sectionParagraph = (value: string, type?: string) =>
  `<w:p><w:pPr><w:sectPr>${type ? `<w:type w:val="${type}"/>` : ''}</w:sectPr></w:pPr>${text(value)}</w:p>`;
const plainParagraph = (value: string) => `<w:p>${text(value)}</w:p>`;
const bodySection = (type?: string) => `<w:sectPr>${type ? `<w:type w:val="${type}"/>` : ''}</w:sectPr>`;

function visibleText(block: FlowBlock): string {
  if (block.kind !== 'paragraph') return '';
  return block.runs
    .map((run) => (run.kind === 'text' ? run.text : run.kind === 'tab' ? '\t' : ''))
    .join('');
}

function laidOut(xml: string) {
  const body = parseDocumentBody(xml);
  const original = { package: { document: body } } as Document;
  const pm = toProseDoc(original);
  const blocks = toFlowBlocks(pm, {});
  const measures = blocks.map((block) => {
    if (block.kind === 'paragraph') return makeParagraphMeasure([makeLine(0, 0, 0, 1, 80, 20)]);
    if (block.kind === 'sectionBreak') return { kind: 'sectionBreak' as const };
    throw new Error(`unexpected block ${block.kind}`);
  });
  const layout = layoutDocument(blocks, measures, {
    ...makeLayoutOptions(),
    bodyBreakType: body.finalSectionProperties?.sectionStart,
  });
  const pages = layout.pages.map((page) =>
    page.fragments
      .map((fragment) => {
        const block = blocks.find((item) => item.id === fragment.blockId);
        return block ? visibleText(block) : '';
      })
      .filter(Boolean),
  );
  return { body, original, pm, blocks, layout, pages };
}

function savedXml(xml: string, edit?: (doc: PMNode) => PMNode): string {
  const body = parseDocumentBody(xml);
  const original = { package: { document: body } } as Document;
  const pm = toProseDoc(original);
  return serializeDocument(fromProseDoc(edit ? edit(pm) : pm, original));
}

function replaceText(doc: PMNode, from: string, to: string): PMNode {
  const state = EditorState.create({ doc });
  let transaction = state.tr;
  let found = false;
  state.doc.descendants((node, pos) => {
    if (found || !node.isText || !node.text) return;
    const at = node.text.indexOf(from);
    if (at < 0) return;
    found = true;
    transaction = transaction.insertText(to, pos + at, pos + at + from.length);
  });
  if (!found) throw new Error(`missing text: ${from}`);
  return transaction.doc;
}

describe('section start types from document XML', () => {
  test('a continuous section followed by an omitted type starts the next section on a new page', () => {
    const { pages } = laidOut(documentXml(sectionParagraph('Cover', 'continuous') + plainParagraph('TOC') + bodySection()));
    expect(pages).toEqual([['Cover'], ['TOC']]);
  });

  test('an explicit continuous next section stays with the previous section', () => {
    const { pages } = laidOut(
      documentXml(sectionParagraph('Cover', 'nextPage') + plainParagraph('TOC') + bodySection('continuous')),
    );
    expect(pages).toEqual([['Cover', 'TOC']]);
  });

  test('omitted types in a three-section document each start a new page', () => {
    const { pages } = laidOut(
      documentXml(sectionParagraph('Cover', 'continuous') + sectionParagraph('TOC') + plainParagraph('Body') + bodySection()),
    );
    expect(pages).toEqual([['Cover'], ['TOC'], ['Body']]);
  });

  test('oddPage inserts the blank page instead of placing the section on an even page', () => {
    const { pages, layout } = laidOut(
      documentXml(sectionParagraph('Cover', 'continuous') + plainParagraph('Body') + bodySection('oddPage')),
    );
    expect(layout.pages).toHaveLength(3);
    expect(layout.pages[2].number % 2).toBe(1);
    expect(pages[2]).toEqual(['Body']);
    expect(pages[1]).toEqual([]);
  });
});

describe('cross-paragraph nested TOC display and save', () => {
  const xml = documentXml(
    `${sectionParagraph('Cover', 'continuous')}<w:p>${tocTabs}${begin}${instruction('TOC')}${separate}${entry('Heading one', 1)}</w:p><w:p>${tocTabs}${entry('Heading two', 2)}</w:p><w:p>${end}</w:p>${bodySection()}`,
  );

  test('keeps the title, dot-leader tab and page number, and starts the TOC on the next page', () => {
    const { blocks, pages } = laidOut(xml);
    const first = blocks.find((block): block is ParagraphBlock => visibleText(block).includes('Heading one'));
    const second = blocks.find((block): block is ParagraphBlock => visibleText(block).includes('Heading two'));
    expect(first?.attrs?.tabs?.[0]?.leader).toBe('dot');
    expect(first?.runs.some((run) => run.kind === 'tab')).toBe(true);
    expect(visibleText(first!)).toContain('Heading one');
    expect(visibleText(first!)).toContain('1');
    expect(visibleText(second!)).toContain('Heading two');
    expect(visibleText(second!)).toContain('2');
    expect(pages[0]).toEqual(['Cover']);
    expect(pages[1]?.some((line) => line.includes('Heading one'))).toBe(true);
    expect(pages[1]?.some((line) => line.includes('Heading two'))).toBe(true);
  });

  test('editing text inside a TOC entry keeps the nested field structure', () => {
    const saved = savedXml(xml, (pm) => replaceText(pm, 'Heading one', 'Heading one revised'));
    expect(saved).toContain('Heading one revised');
    expect(saved).toContain('Heading two');
    expect(saved).toContain('w:leader="dot"');
    expect((saved.match(/w:fldCharType="begin"/g) ?? []).length).toBe(5);
    expect((saved.match(/w:fldCharType="end"/g) ?? []).length).toBe(5);
    expect((saved.match(/HYPERLINK/g) ?? []).length).toBe(2);
    expect((saved.match(/PAGEREF/g) ?? []).length).toBe(2);
    expect((saved.match(/<w:tab\s*\/>/g) ?? []).length).toBe(2);
  });

  test('a table between an unclosed TOC field and its end survives a save', () => {
    const source = documentXml(
      `<w:p>${begin}${instruction('TOC')}${separate}${text('Before table')}</w:p><w:tbl><w:tr><w:tc><w:p>${text('Cell title')}</w:p></w:tc></w:tr></w:tbl><w:p>${text('After table')}${end}</w:p>`,
    );
    const saved = savedXml(source);
    expect(saved).toContain('Before table');
    expect(saved).toContain('Cell title');
    expect(saved).toContain('After table');
    expect((saved.match(/w:fldCharType="begin"/g) ?? []).length).toBe(1);
    expect((saved.match(/w:fldCharType="end"/g) ?? []).length).toBe(1);
    expect(saved).toContain('TOC');
  });

  test('a content control inside an unclosed field keeps its text and the field markers', () => {
    const source = documentXml(
      `<w:p>${begin}${instruction('TOC')}${separate}<w:sdt><w:sdtPr><w:alias w:val="toc-entry"/></w:sdtPr><w:sdtContent>${text('Control title')}</w:sdtContent></w:sdt></w:p><w:p>${end}</w:p>`,
    );
    const saved = savedXml(source);
    expect(saved).toContain('Control title');
    expect(saved).toContain('<w:sdt>');
    expect(saved).toContain('toc-entry');
    expect((saved.match(/w:fldCharType="begin"/g) ?? []).length).toBe(1);
    expect((saved.match(/w:fldCharType="end"/g) ?? []).length).toBe(1);
  });
});
