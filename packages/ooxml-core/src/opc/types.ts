/** One OPC part (zip entry) with optional dirty tracking. */
export interface OpcPart {
  /** Zip path using forward slashes, e.g. `xl/workbook.xml`. */
  name: string;
  /** Uncompressed UTF-8 / binary bytes currently in memory (if loaded). */
  data?: Uint8Array;
  /** True when `data` diverges from the bytes that were last loaded/saved. */
  dirty: boolean;
  /** Whether this entry is a directory placeholder. */
  dir: boolean;
}

export interface OpcSaveOptions {
  /** Compression level for dirty parts. Clean parts reuse stored compressed bytes. */
  compression?: 'STORE' | 'DEFLATE';
}
