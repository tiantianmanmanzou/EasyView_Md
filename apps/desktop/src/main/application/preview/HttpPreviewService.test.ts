import { describe, expect, it } from 'vitest';
import { requestHttpPreview } from './HttpPreviewService';

describe('requestHttpPreview', () => {
  it('rejects non-http schemes and loopback targets before network I/O', async () => {
    await expect(requestHttpPreview({ url: 'file:///etc/passwd' })).rejects.toMatchObject({ kind: 'permission' });
    await expect(requestHttpPreview({ url: 'http://127.0.0.1:8080/' })).rejects.toMatchObject({ kind: 'permission' });
    await expect(requestHttpPreview({ url: 'http://[::1]/' })).rejects.toMatchObject({ kind: 'permission' });
  });

  it('rejects request-smuggling-sensitive headers before network I/O', async () => {
    await expect(requestHttpPreview({ url: 'https://example.com', headers: { Host: 'other.example' } })).rejects.toMatchObject({ kind: 'permission' });
    await expect(requestHttpPreview({ url: 'https://example.com', headers: { Accept: 'text/plain\r\nX-Evil: 1' } })).rejects.toMatchObject({ kind: 'invalid' });
  });
});
