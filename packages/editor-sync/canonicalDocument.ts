export type DocumentEol = '\n' | '\r\n' | '\r';

export interface RawRange {
  from: number;
  to: number;
}

export interface CanonicalDocument {
  readonly rawContent: string;
  readonly content: string;
  readonly eol: DocumentEol;
  readonly strippedSettingsRange: RawRange | null;
  canonicalToRawOffset(offset: number): number;
  rawToCanonicalOffset(offset: number): number;
  canonicalToRawRange(range: RawRange): RawRange;
  toRawContent(canonicalContent?: string): string;
}

const LEGACY_SETTINGS_COMMENT = /^<!--\s*fullWidth:\s*(?:true|false)(?:\s+tocVisible:\s*(?:true|false))?(?:\s+tableWrap:\s*(?:true|false))?(?:\s+lineNumbersVisible:\s*(?:true|false))?\s*-->[\r\n]*/;

function detectEol(raw: string): DocumentEol {
  const match = raw.match(/\r\n|\r|\n/);
  return match?.[0] as DocumentEol | undefined ?? '\n';
}

function normalizeWithMap(raw: string): { content: string; rawOffsets: number[] } {
  let content = '';
  const rawOffsets = [0];
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === '\r') {
      if (raw[index + 1] === '\n') index += 1;
      content += '\n';
      rawOffsets.push(index + 1);
    } else {
      content += character;
      rawOffsets.push(index + 1);
    }
  }
  return { content, rawOffsets };
}

export function createCanonicalDocument(rawContent: string): CanonicalDocument {
  const eol = detectEol(rawContent);
  const settingsMatch = LEGACY_SETTINGS_COMMENT.exec(rawContent);
  const strippedSettingsRange = settingsMatch
    ? { from: 0, to: settingsMatch[0].length }
    : null;
  const body = settingsMatch ? rawContent.slice(settingsMatch[0].length) : rawContent;
  const normalized = normalizeWithMap(body);
  const canonicalToRaw = normalized.rawOffsets.map((offset) => offset + (strippedSettingsRange?.to ?? 0));
  const rawBodyStart = strippedSettingsRange?.to ?? 0;
  const canonicalToRawOffset = (offset: number): number => {
    if (!Number.isInteger(offset) || offset < 0 || offset > normalized.content.length) {
      throw new RangeError(`Canonical offset ${offset} is outside [0, ${normalized.content.length}]`);
    }
    return canonicalToRaw[offset];
  };

  return {
    rawContent,
    content: normalized.content,
    eol,
    strippedSettingsRange,
    canonicalToRawOffset,
    rawToCanonicalOffset(offset: number): number {
      if (!Number.isInteger(offset) || offset < 0 || offset > rawContent.length) {
        throw new RangeError(`Raw offset ${offset} is outside [0, ${rawContent.length}]`);
      }
      if (offset <= rawBodyStart) return 0;
      let low = 0;
      let high = canonicalToRaw.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (canonicalToRaw[middle] < offset) low = middle;
        else high = middle - 1;
      }
      return canonicalToRaw[low] <= offset ? low : Math.max(0, low - 1);
    },
    toRawContent(canonicalContent = normalized.content): string {
      if (canonicalContent.includes('\r')) throw new Error('Canonical content must use LF line endings');
      const bodyContent = eol === '\n' ? canonicalContent : canonicalContent.replaceAll('\n', eol);
      return (settingsMatch?.[0] ?? '') + bodyContent;
    },
    canonicalToRawRange(range: RawRange): RawRange {
      if (range.from < 0 || range.to < range.from || range.to > normalized.content.length) {
        throw new RangeError('Canonical range is outside the document');
      }
      return {
        from: canonicalToRawOffset(range.from),
        to: canonicalToRawOffset(range.to),
      };
    },
  };
}

export { LEGACY_SETTINGS_COMMENT };
