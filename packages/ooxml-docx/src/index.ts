/**
 * docx adapter — scaffold. P2 merges docx-core writeback and switches AI to body ops.
 */
export const OOXML_DOCX_KIND = 'docx' as const;

export function createDocxAdapterStub(): {
  kind: 'docx';
  note: string;
} {
  return {
    kind: OOXML_DOCX_KIND,
    note: 'Scaffold only. Merge docx-core into this adapter in P2; AI applies body ops.',
  };
}
