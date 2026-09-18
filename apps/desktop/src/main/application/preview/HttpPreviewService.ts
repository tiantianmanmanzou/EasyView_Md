import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { HttpPreviewRequest, HttpPreviewResponse } from '../../../contracts';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const ALLOWED_METHODS = new Set<HttpPreviewRequest['method']>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const FORBIDDEN_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'cookie', 'proxy-authorization', 'proxy-connection']);

export class HttpPreviewError extends Error {
  constructor(readonly kind: 'invalid' | 'permission' | 'network', message: string) {
    super(message);
    this.name = 'HttpPreviewError';
  }
}

export async function requestHttpPreview(request: HttpPreviewRequest): Promise<HttpPreviewResponse> {
  const normalized = normalizeRequest(request);
  return requestFollowingRedirects(normalized, 0);
}

interface NormalizedRequest {
  url: URL;
  method: NonNullable<HttpPreviewRequest['method']>;
  headers: Record<string, string>;
  body: string | undefined;
  timeoutMs: number;
}

function normalizeRequest(request: HttpPreviewRequest): NormalizedRequest {
  if (!request || typeof request.url !== 'string') throw new HttpPreviewError('invalid', 'HTTP 地址无效');
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new HttpPreviewError('invalid', 'HTTP 地址无效');
  }
  assertPublicHttpUrl(url);
  const method = request.method ?? 'GET';
  if (!ALLOWED_METHODS.has(method)) throw new HttpPreviewError('invalid', 'HTTP 方法无效');
  if ((method === 'GET' || method === 'HEAD') && request.body) throw new HttpPreviewError('invalid', `${method} 请求不允许请求体`);
  if (request.body !== undefined && (typeof request.body !== 'string' || Buffer.byteLength(request.body, 'utf8') > MAX_REQUEST_BODY_BYTES)) {
    throw new HttpPreviewError('invalid', 'HTTP 请求体超过 1 MiB 上限');
  }
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new HttpPreviewError('invalid', 'HTTP 超时参数无效');
  return { url, method, headers: normalizeHeaders(request.headers), body: request.body, timeoutMs };
}

async function requestFollowingRedirects(request: NormalizedRequest, redirectCount: number): Promise<HttpPreviewResponse> {
  await assertPublicHostname(request.url.hostname);
  const response = await makeRequest(request);
  if (isRedirect(response.statusCode) && response.headers.location) {
    if (redirectCount >= MAX_REDIRECTS) throw new HttpPreviewError('network', 'HTTP 重定向次数超过上限');
    const nextUrl = new URL(response.headers.location, request.url);
    assertPublicHttpUrl(nextUrl);
    return requestFollowingRedirects({ ...request, url: nextUrl, method: response.statusCode === 303 ? 'GET' : request.method, body: response.statusCode === 303 ? undefined : request.body }, redirectCount + 1);
  }
  const body = await readResponseBody(response);
  const headers = Object.fromEntries(Object.entries(response.headers).flatMap(([key, value]) => {
    if (value === undefined || key.toLowerCase() === 'set-cookie') return [];
    return [[key, Array.isArray(value) ? value.join(', ') : value]];
  }));
  return {
    url: request.url.toString(),
    status: response.statusCode ?? 0,
    statusText: response.statusMessage ?? '',
    headers,
    contentType: typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : null,
    body: new TextDecoder().decode(body.bytes),
    truncated: body.truncated,
  };
}

function makeRequest(request: NormalizedRequest): Promise<http.IncomingMessage> {
  const transport = request.url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const rawRequest = transport.request(request.url, {
      method: request.method,
      headers: request.headers,
      timeout: request.timeoutMs,
      lookup: safeLookup,
      rejectUnauthorized: true,
    }, resolve);
    rawRequest.once('timeout', () => rawRequest.destroy(new HttpPreviewError('network', 'HTTP 请求超时')));
    rawRequest.once('error', (error) => reject(error instanceof HttpPreviewError ? error : new HttpPreviewError('network', error.message)));
    if (request.body !== undefined) rawRequest.write(request.body, 'utf8');
    rawRequest.end();
  });
}

function safeLookup(hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void): void {
  void lookup(hostname, { all: true, verbatim: true }).then((results) => {
    const allowed = results.find((result) => !isPrivateAddress(result.address));
    if (!allowed) throw new HttpPreviewError('permission', '禁止请求本机、内网或保留地址');
    callback(null, allowed.address, allowed.family);
  }).catch((error) => {
    callback(error instanceof Error ? Object.assign(error, { code: 'EHOSTUNREACH' }) : new Error('域名解析失败') as NodeJS.ErrnoException, '', 0);
  });
}

function readResponseBody(response: http.IncomingMessage): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    response.on('data', (chunk: Buffer) => {
      if (finished) return;
      const remaining = MAX_BODY_BYTES - size;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, Math.max(0, remaining)));
        size = MAX_BODY_BYTES;
        finished = true;
        response.destroy();
        resolve({ bytes: Buffer.concat(chunks, size), truncated: true });
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    response.once('end', () => {
      if (!finished) resolve({ bytes: Buffer.concat(chunks, size), truncated: false });
    });
    response.once('error', (error) => {
      if (!finished) reject(new HttpPreviewError('network', error.message));
    });
  });
}

function normalizeHeaders(headers: HttpPreviewRequest['headers']): Record<string, string> {
  if (headers === undefined) return {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new HttpPreviewError('invalid', 'HTTP 请求头无效');
  const result: Record<string, string> = {};
  const entries = Object.entries(headers);
  if (entries.length > 32) throw new HttpPreviewError('invalid', 'HTTP 请求头数量超过上限');
  for (const [name, value] of entries) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value) || Buffer.byteLength(value, 'utf8') > 8192) {
      throw new HttpPreviewError('invalid', 'HTTP 请求头无效');
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new HttpPreviewError('permission', `不允许设置 ${name} 请求头`);
    result[name] = value;
  }
  return result;
}

function assertPublicHttpUrl(url: URL): void {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpPreviewError('permission', '仅允许 HTTP 或 HTTPS 地址');
  if (url.username || url.password) throw new HttpPreviewError('permission', 'URL 中不允许包含账号信息');
  if (hostname.toLowerCase() === 'localhost' || net.isIP(hostname) !== 0 && isPrivateAddress(hostname)) {
    throw new HttpPreviewError('permission', '禁止请求本机、内网或保留地址');
  }
}

async function assertPublicHostname(hostname: string): Promise<void> {
  hostname = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname)) throw new HttpPreviewError('permission', '禁止请求本机、内网或保留地址');
    return;
  }
  const results = await lookup(hostname, { all: true, verbatim: true });
  if (!results.length || results.some((result) => isPrivateAddress(result.address))) {
    throw new HttpPreviewError('permission', '禁止请求解析到本机、内网或保留地址的域名');
  }
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const normalized = address.toLowerCase();
  const mappedV4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedV4) return isPrivateAddress(mappedV4[1]);
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('ff');
}

function isRedirect(statusCode: number | undefined): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}
