import { describe, expect, it } from 'vitest';
import { isPhase1PreviewRoute, PHASE1_PREVIEW_ROUTES } from '../src/phase1';

describe('phase-1 preview routes', () => {
  it('recognizes the shared phase-1 set', () => {
    expect(PHASE1_PREVIEW_ROUTES).toContain('spreadsheet');
    expect(PHASE1_PREVIEW_ROUTES).toContain('powerpoint');
    expect(PHASE1_PREVIEW_ROUTES).toContain('design');
    expect(PHASE1_PREVIEW_ROUTES).toContain('archive');
    expect(isPhase1PreviewRoute('pdf')).toBe(true);
    expect(isPhase1PreviewRoute('design')).toBe(true);
    expect(isPhase1PreviewRoute('archive')).toBe(true);
    expect(isPhase1PreviewRoute(null)).toBe(false);
  });
});
