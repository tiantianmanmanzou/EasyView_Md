import type { OpcPackage } from '@easyview/ooxml-core/opc';
import type { DocumentOp, FormatAdapter, Locator } from '@easyview/ooxml-core/ops';
import { DocxDocument, type DocxBodyOp } from './document';

const documentCache = new WeakMap<OpcPackage, DocxDocument>();

async function documentFor(pkg: OpcPackage): Promise<DocxDocument> {
  const cached = documentCache.get(pkg);
  if (cached) return cached;
  const document = await DocxDocument.open(pkg);
  documentCache.set(pkg, document);
  return document;
}

function bodyOpsFromDocument(ops: DocumentOp[]): DocxBodyOp[] {
  return ops.map((op) => {
    const args = (op.args ?? {}) as Record<string, unknown>;
    if (op.op === 'bodyOp') return args as unknown as DocxBodyOp;
    return { op: op.op, ...args } as DocxBodyOp;
  });
}

export function createDocxAdapter(): FormatAdapter {
  return {
    kind: 'docx',
    async summary(pkg) {
      const document = await documentFor(pkg);
      const { paragraphCount } = await document.previewText(0);
      return {
        kind: 'docx',
        paragraphCount,
        parts: pkg.listParts(),
      };
    },
    async read(pkg, locator: Locator) {
      const document = await documentFor(pkg);
      if (locator.key === 'preview') {
        const max = typeof (locator as { max?: number }).max === 'number' ? (locator as { max: number }).max : 80;
        return document.previewText(max);
      }
      if (locator.key?.startsWith('paragraph:')) {
        const index = Number(locator.key.slice('paragraph:'.length));
        const [paragraph] = await document.listParagraphs({ fromIndex: index, toIndex: index });
        return paragraph ?? null;
      }
      return document.previewText(80);
    },
    async apply(pkg, ops: DocumentOp[]) {
      const document = await documentFor(pkg);
      await document.applyBodyOps(bodyOpsFromDocument(ops));
      return document.flush();
    },
  };
}

export async function getDocxDocument(pkg: OpcPackage): Promise<DocxDocument> {
  return documentFor(pkg);
}
