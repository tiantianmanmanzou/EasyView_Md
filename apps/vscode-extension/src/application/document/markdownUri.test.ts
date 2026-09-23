import { describe, expect, it } from 'vitest';
import { EASYVIEW_MD_SCHEME } from './markdownUri';

describe('markdownUri constants', () => {
  it('uses a stable EasyView markdown scheme', () => {
    expect(EASYVIEW_MD_SCHEME).toBe('easyviewMd');
  });
});
