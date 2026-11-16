import type { OpcPackage } from '@easyview/ooxml-core/opc';
import type { DocumentOp, FormatAdapter, Locator } from '@easyview/ooxml-core/ops';
import { PptxPresentation } from './presentation';

const presentationCache = new WeakMap<OpcPackage, PptxPresentation>();

async function presentationFor(pkg: OpcPackage): Promise<PptxPresentation> {
  const cached = presentationCache.get(pkg);
  if (cached) return cached;
  const presentation = await PptxPresentation.open(pkg);
  presentationCache.set(pkg, presentation);
  return presentation;
}

export type PptxSlideOp =
  | { op: 'setShapeText'; slideIndex: number; shapeId: number; text: string }
  | { op: 'clearShapeText'; slideIndex: number; shapeId: number }
  | { op: 'replaceText'; slideIndex: number; search: string; replaceWith: string }
  | { op: 'replaceTextAll'; slideIndex: number; search: string; replaceWith: string }
  | { op: 'replaceTextInPresentation'; search: string; replaceWith: string };

function opsFromDocument(ops: DocumentOp[]): PptxSlideOp[] {
  return ops.map((op) => {
    const args = (op.args ?? {}) as Record<string, unknown>;
    if (op.op === 'slideOp') return args as unknown as PptxSlideOp;
    return { op: op.op, ...args } as PptxSlideOp;
  });
}

export async function applySlideOp(presentation: PptxPresentation, op: PptxSlideOp): Promise<string> {
  if (op.op === 'setShapeText') {
    await presentation.setShapeText(op.slideIndex, op.shapeId, op.text);
    return `setShapeText slide ${op.slideIndex} shape ${op.shapeId}`;
  }
  if (op.op === 'clearShapeText') {
    await presentation.clearShapeText(op.slideIndex, op.shapeId);
    return `clearShapeText slide ${op.slideIndex} shape ${op.shapeId}`;
  }
  if (op.op === 'replaceTextAll') {
    const count = await presentation.replaceTextAll(op.slideIndex, op.search, op.replaceWith);
    if (!count) throw new Error(`Text not found on slide ${op.slideIndex}: ${op.search}`);
    return `replaceTextAll slide ${op.slideIndex} x${count}`;
  }
  if (op.op === 'replaceTextInPresentation') {
    const count = await presentation.replaceTextInPresentation(op.search, op.replaceWith);
    if (!count) throw new Error(`Text not found in presentation: ${op.search}`);
    return `replaceTextInPresentation x${count}`;
  }
  const ok = await presentation.replaceText(op.slideIndex, op.search, op.replaceWith);
  if (!ok) throw new Error(`Text not found on slide ${op.slideIndex}: ${op.search}`);
  return `replaceText slide ${op.slideIndex}`;
}

export function createPptxAdapter(): FormatAdapter {
  return {
    kind: 'pptx',
    async summary(pkg) {
      const presentation = await presentationFor(pkg);
      return {
        kind: 'pptx',
        slideCount: presentation.slides.length,
        slides: presentation.slides.map((slide) => ({ index: slide.index, path: slide.path })),
        parts: pkg.listParts(),
      };
    },
    async read(pkg, locator: Locator) {
      const presentation = await presentationFor(pkg);
      if (locator.key?.startsWith('slide:')) {
        const index = Number(locator.key.slice('slide:'.length));
        return { index, shapes: await presentation.listShapes(index) };
      }
      return presentation.summarize(20);
    },
    async apply(pkg, ops: DocumentOp[]) {
      const presentation = await presentationFor(pkg);
      for (const op of opsFromDocument(ops)) {
        await applySlideOp(presentation, op);
      }
      return presentation.flush();
    },
  };
}

export async function getPptxPresentation(pkg: OpcPackage): Promise<PptxPresentation> {
  return presentationFor(pkg);
}
