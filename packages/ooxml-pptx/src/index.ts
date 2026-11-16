/**
 * pptx adapter — slide/shape text query + precise XML apply on ooxml-core.
 */
export const OOXML_PPTX_KIND = 'pptx' as const;

export { createPptxAdapter, getPptxPresentation, applySlideOp, type PptxSlideOp } from './adapter';
export {
  PptxPresentation,
  type PptxSlideInfo,
  type PptxShapeText,
} from './presentation';
