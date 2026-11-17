import JSZip from 'jszip';
import type { OpcPart, OpcSaveOptions } from './types';

/**
 * OPC package opened from an OOXML zip. Clean parts keep the original
 * JSZipObject so `generateAsync` can copy compressed bytes without reinflating.
 */
export class OpcPackage {
  private constructor(
    private zip: JSZip,
    private readonly parts = new Map<string, OpcPart>(),
  ) {}

  static async open(bytes: Uint8Array | ArrayBuffer): Promise<OpcPackage> {
    const zip = await JSZip.loadAsync(bytes);
    const pkg = new OpcPackage(zip);
    for (const [name, entry] of Object.entries(zip.files)) {
      pkg.parts.set(normalizePartName(name), {
        name: normalizePartName(name),
        dirty: false,
        dir: entry.dir,
      });
    }
    return pkg;
  }

  listParts(): string[] {
    return [...this.parts.keys()].filter((name) => !this.parts.get(name)?.dir).sort();
  }

  hasPart(name: string): boolean {
    const part = this.parts.get(normalizePartName(name));
    return Boolean(part && !part.dir);
  }

  async readPart(name: string): Promise<Uint8Array> {
    const key = normalizePartName(name);
    const part = this.parts.get(key);
    if (!part || part.dir) throw new Error(`OPC part missing: ${key}`);
    if (part.data) return part.data;
    const entry = this.zip.file(key);
    if (!entry) throw new Error(`OPC zip entry missing: ${key}`);
    const data = await entry.async('uint8array');
    part.data = data;
    return data;
  }

  async readPartText(name: string): Promise<string> {
    return new TextDecoder('utf-8').decode(await this.readPart(name));
  }

  /** Replace part bytes and mark dirty (will be recompressed on save). */
  writePart(name: string, data: Uint8Array): void {
    const key = normalizePartName(name);
    const existing = this.parts.get(key);
    const part: OpcPart = existing ?? { name: key, dirty: true, dir: false };
    part.data = data;
    part.dirty = true;
    part.dir = false;
    this.parts.set(key, part);
    this.zip.file(key, data);
  }

  writePartText(name: string, text: string): void {
    this.writePart(name, new TextEncoder().encode(text));
  }

  deletePart(name: string): void {
    const key = normalizePartName(name);
    this.parts.delete(key);
    this.zip.remove(key);
  }

  isDirty(name?: string): boolean {
    if (name) return Boolean(this.parts.get(normalizePartName(name))?.dirty);
    for (const part of this.parts.values()) {
      if (!part.dir && part.dirty) return true;
    }
    return false;
  }

  /**
   * Write the package. Dirty parts are taken from in-memory bytes; clean parts
   * reuse the original zip entry objects so compressed payloads stay intact.
   */
  async save(options: OpcSaveOptions = {}): Promise<Uint8Array> {
    const compression = options.compression === 'STORE' ? 'STORE' : 'DEFLATE';
    const output = new JSZip();

    for (const [name, part] of this.parts) {
      if (part.dir) continue;
      if (part.dirty) {
        const data = part.data ?? (await this.readPart(name));
        output.file(name, data, { compression });
        continue;
      }
      const entry = this.zip.files[name];
      if (entry) {
        // Share the original entry so generateAsync can copy compressed bytes.
        output.files[name] = entry;
      }
    }

    const bytes = await output.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    // Refresh baseline: reload from saved bytes so subsequent saves stay clean.
    const next = await OpcPackage.open(bytes);
    this.zip = next.zip;
    this.parts.clear();
    for (const [name, part] of next.parts) this.parts.set(name, part);
    return bytes;
  }

  /** SHA-256 of each non-directory part's uncompressed bytes (Web Crypto — browser-safe). */
  async partDigests(): Promise<Map<string, string>> {
    const digests = new Map<string, string>();
    for (const name of this.listParts()) {
      const data = await this.readPart(name);
      digests.set(name, await sha256Hex(data));
    }
    return digests;
  }
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable in this runtime');
  // Copy into a plain ArrayBuffer — some runtimes reject SharedArrayBuffer views.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizePartName(name: string): string {
  return name.replace(/^\/+/, '').replace(/\\/g, '/');
}
