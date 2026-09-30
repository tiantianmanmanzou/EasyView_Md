import { protocol, type Protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { PreviewSessionStore } from '../../application/preview/PreviewSession';

const PREVIEW_SCHEME = 'easyview-preview';

export interface ByteRange {
  start: number;
  end: number;
}

export function parsePreviewContentPath(pathname: string): { contentId: string; assetPath: string } | null {
  const raw = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  if (!raw) return null;
  const slash = raw.indexOf('/');
  const contentId = decodeURIComponent(slash === -1 ? raw : raw.slice(0, slash));
  const assetPath = slash === -1 ? '' : decodeURIComponent(raw.slice(slash + 1));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(contentId)) return null;
  return { contentId, assetPath };
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

export function registerPreviewProtocol(
  electronProtocol: Protocol,
  sessions: Pick<PreviewSessionStore, 'resolveContent' | 'resolveRelatedContent'>,
): void {
  electronProtocol.handle(PREVIEW_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'content') return new Response('Not found', { status: 404, headers: corsHeaders() });
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      const parsed = parsePreviewContentPath(url.pathname);
      if (!parsed) return new Response('Not found', { status: 404, headers: corsHeaders() });
      const content = parsed.assetPath
        ? await sessions.resolveRelatedContent(parsed.contentId, parsed.assetPath)
        : await sessions.resolveContent(parsed.contentId);
      const size = content.kind === 'memory' ? content.bytes.length : content.size;
      const range = parseByteRange(request.headers.get('range'), size);
      if (range === 'invalid') {
        return new Response(null, { status: 416, headers: { ...corsHeaders(), 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' } });
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
      return new Response('Not found', { status: 404, headers: corsHeaders() });
    }
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
  };
}

function secureHeaders(contentType: string, contentLength: number, range: { start: number; end: number; size: number } | null): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(contentLength),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders(),
  };
  if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${range.size}`;
  if (contentType.startsWith('text/html') || contentType === 'image/svg+xml') {
    // Allow nested iframe / fetch / module loads of sibling workspace files.
    headers['Content-Security-Policy'] = [
      "default-src 'self' easyview-preview: blob: data:",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' easyview-preview: blob:",
      "style-src 'self' 'unsafe-inline' easyview-preview: blob: data:",
      "img-src 'self' data: blob: easyview-preview: http: https:",
      "font-src 'self' data: blob: easyview-preview: http: https:",
      "connect-src 'self' easyview-preview: blob: data:",
      "frame-src 'self' easyview-preview: blob: data: about:",
      "worker-src 'self' blob: easyview-preview:",
      "media-src 'self' data: blob: easyview-preview:",
      "base-uri 'self' easyview-preview:",
    ].join('; ');
  }
  return headers;
}
