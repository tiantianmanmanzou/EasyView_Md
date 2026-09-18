import { protocol, type Protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { PreviewSessionStore } from '../../application/preview/PreviewSession';

const PREVIEW_SCHEME = 'easyview-preview';

export interface ByteRange {
  start: number;
  end: number;
}

export function parseByteRange(value: string | null, size: number): ByteRange | null | 'invalid' {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0) return 'invalid';
  const [, startText, endText] = match;
  if (!startText && !endText) return 'invalid';
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return 'invalid';
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
}

export function registerPreviewProtocol(electronProtocol: Protocol, sessions: PreviewSessionStore): void {
  electronProtocol.handle(PREVIEW_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'content') return new Response('Not found', { status: 404 });
      const contentId = decodeURIComponent(url.pathname.slice(1));
      const content = await sessions.resolveContent(contentId);
      const size = content.kind === 'memory' ? content.bytes.length : content.size;
      const range = parseByteRange(request.headers.get('range'), size);
      if (range === 'invalid') {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' } });
      }
      const start = range?.start ?? 0;
      const end = range?.end ?? Math.max(0, size - 1);
      const length = size === 0 ? 0 : end - start + 1;
      const headers = secureHeaders(content.mimeType, length, range ? { start, end, size } : null);
      if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
      if (content.kind === 'memory') {
        const bytes = size === 0 ? content.bytes : content.bytes.subarray(start, end + 1);
        return new Response(new Blob([new Uint8Array(bytes)], { type: content.mimeType }), { status: range ? 206 : 200, headers });
      }
      const body = size === 0 ? null : Readable.toWeb(createReadStream(content.filePath, { start, end })) as unknown as BodyInit;
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch {
      // Do not expose workspace paths or session state through protocol errors.
      return new Response('Not found', { status: 404 });
    }
  });
}

function secureHeaders(contentType: string, contentLength: number, range: { start: number; end: number; size: number } | null): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(contentLength),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${range.size}`;
  if (contentType.startsWith('text/html') || contentType === 'image/svg+xml') {
    headers['Content-Security-Policy'] = "default-src 'none'; img-src data: easyview-preview:; style-src 'unsafe-inline'; font-src data: easyview-preview:; base-uri 'none'; form-action 'none'";
  }
  return headers;
}
