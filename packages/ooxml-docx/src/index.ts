/**
 * docx adapter — AI body apply via DocxDocument (acceptAll into body).
 * Precise run-level XML writeback replaces the Reviewer rewrite in a later pass.
 */
export const OOXML_DOCX_KIND = 'docx' as const;

export { createDocxAdapter, getDocxDocument } from './adapter';
export {
  DocxDocument,
  type DocxBodyOp,
  type DocxParagraph,
} from './document';
