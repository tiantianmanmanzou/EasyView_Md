import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  detectImageMime,
  ImageServiceError,
  MAX_IMAGE_BYTES,
  normalizeImageMimeType,
} from './image-security';

export { MAX_IMAGE_BYTES } from './image-security';

export const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;
export const MAX_IMAGE_REDIRECTS = 5;

export type AddressLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export type RemoteFetch = (input: string, init?: { redirect: "manual"; signal: AbortSignal }) => Promise<Response>;

function ipv4ToNumbers(value: string): number[] | null {
  const numbers = value.split(".").map(Number);
  return numbers.length === 4 && numbers.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? numbers : null;
}

function isForbiddenIpv4(value: string): boolean {
  const parts = ipv4ToNumbers(value);
  if (!parts) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 2 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0) || a >= 224;
}

function normalizeIpv6(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "");
}

function isForbiddenIpv6(value: string): boolean {
  const normalized = normalizeIpv6(value);
  if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe80:")
    || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8:")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isForbiddenIpv4(mapped[1]) : false;
}

export function isForbiddenAddress(address: string): boolean {
  const normalized = normalizeIpv6(address);
  const version = isIP(normalized);
  if (version === 4) return isForbiddenIpv4(normalized);
  if (version === 6) return isForbiddenIpv6(normalized);
  return true;
}

function isObviousBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")
    || normalized === "metadata.google.internal" || normalized === "metadata" || normalized === "instance-data.ec2.internal";
}

export function isAllowedImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const literalAddress = isIP(normalizeIpv6(url.hostname));
    return (url.protocol === "http:" || url.protocol === "https:")
      && !isObviousBlockedHostname(url.hostname)
      && (literalAddress === 0 || !isForbiddenAddress(url.hostname));
  } catch {
    return false;
  }
}

const defaultAddressLookup: AddressLookup = async (hostname) => lookup(hostname, { all: true, verbatim: true });

export async function resolveAndValidateImageUrl(
  value: string,
  resolveAddresses: AddressLookup = defaultAddressLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid image URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS image URLs are allowed");
  const literalAddress = isIP(normalizeIpv6(url.hostname));
  if (isObviousBlockedHostname(url.hostname) || (literalAddress !== 0 && isForbiddenAddress(url.hostname))) throw new Error("Remote image host is not allowed");
  if (literalAddress === 0) {
    const addresses = await resolveAddresses(url.hostname);
    if (addresses.length === 0 || addresses.some(({ address }) => isForbiddenAddress(address))) throw new Error("Remote image host resolves to a private or local address");
  }
  return url;
}

async function validatePublicUrl(urlValue: string, resolveAddresses: AddressLookup): Promise<URL> {
  try {
    return await resolveAndValidateImageUrl(urlValue, resolveAddresses);
  } catch (error) {
    if (error instanceof ImageServiceError) throw error;
    throw new ImageServiceError("IMAGE_DOWNLOAD_FAILED", error instanceof Error ? error.message : String(error));
  }
}

async function readResponseBytes(response: Response): Promise<Buffer> {
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new ImageServiceError("INVALID_IMAGE", "Downloaded image exceeds the 20 MB limit.");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new ImageServiceError("INVALID_IMAGE", "Downloaded image exceeds the 20 MB limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function fetchRemoteImage(options: {
  url: string;
  fetchImpl?: RemoteFetch;
  resolveHostname?: AddressLookup;
  timeoutMs?: number;
}): Promise<{ mimeType: ReturnType<typeof normalizeImageMimeType>; bytes: Buffer }> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const resolveHostname = options.resolveHostname ?? defaultAddressLookup;
  const timeoutMs = options.timeoutMs ?? IMAGE_DOWNLOAD_TIMEOUT_MS;
  let current = await validatePublicUrl(options.url, resolveHostname);

  for (let redirect = 0; redirect <= MAX_IMAGE_REDIRECTS; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(current.toString(), { redirect: "manual", signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      throw new ImageServiceError("IMAGE_DOWNLOAD_FAILED", `Failed to download image: ${String(error)}`);
    }

    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timer);
      if (redirect === MAX_IMAGE_REDIRECTS) throw new ImageServiceError("IMAGE_DOWNLOAD_FAILED", "Too many image redirects.");
      const location = response.headers.get("location");
      if (!location) throw new ImageServiceError("IMAGE_DOWNLOAD_FAILED", "Image redirect did not provide a destination.");
      current = await validatePublicUrl(new URL(location, current).toString(), resolveHostname);
      continue;
    }
    if (!response.ok) {
      clearTimeout(timer);
      throw new ImageServiceError("IMAGE_DOWNLOAD_FAILED", `Image download returned HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    let mimeType: ReturnType<typeof normalizeImageMimeType>;
    try {
      mimeType = normalizeImageMimeType(contentType);
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
      clearTimeout(timer);
      throw new ImageServiceError("INVALID_IMAGE", "Downloaded image exceeds the 20 MB limit.");
    }
    try {
    const bytes = await readResponseBytes(response);
    if (bytes.length === 0) throw new ImageServiceError("INVALID_IMAGE", "Downloaded image is empty.");
    if (detectImageMime(bytes) !== mimeType) throw new ImageServiceError("INVALID_IMAGE", "Image MIME type does not match its contents.");
    return { mimeType, bytes };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ImageServiceError("IMAGE_DOWNLOAD_FAILED", "Unable to download image.");
}

export function downloadRemoteImage(urlValue: string): Promise<Buffer> {
  return fetchRemoteImage({ url: urlValue }).then(({ bytes }) => bytes);
}
