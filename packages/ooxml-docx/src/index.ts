/**
 * docx adapter — AI body text via precise run-level XML; comments via DocxReviewer.
 */
export const OOXML_DOCX_KIND = 'docx' as const;

export { createDocxAdapter, getDocxDocument } from './adapter';
export {
  DocxDocument,
  type DocxBodyOp,
  type DocxParagraph,
} from './document';
