/** A deterministic, platform-independent hash for canonical text. */
export function hashContent(content: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= BigInt(content.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export const hashCanonicalContent = hashContent;
