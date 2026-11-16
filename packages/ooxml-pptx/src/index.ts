/**
 * pptx adapter — scaffold. P3 implements slide/shape text ops on ooxml-core.
 */
export const OOXML_PPTX_KIND = 'pptx' as const;

export function createPptxAdapterStub(): {
  kind: 'pptx';
  note: string;
} {
  return {
    kind: OOXML_PPTX_KIND,
    note: 'Scaffold only. Implement slide/shape query/apply in P3.',
  };
}
