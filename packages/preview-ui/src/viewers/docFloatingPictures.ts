/**
 * @file-viewer/doc leaves two kinds of .doc pictures wrong.
 * Floating pictures (stamps, logos) are never read from PlcSpaMom, so this overlays them on
 * the paragraph they are anchored to. An inline picture is also dropped when a text-box
 * placeholder (U+0008) sits earlier in the same paragraph: the renderer deletes that character
 * and then slices the shortened string with the original character positions, so the picture
 * character falls off the end. Those are inserted back at the paragraph.
 * Tab stops default to the document's dxaTab. The renderer leaves them to CSS (8ch), which
 * pushes tabbed lines away from a stamp that Word draws against the real stops.
 * Pages take the first section's paper size and margins and are paginated by height (see
 * docPagination), since the renderer only breaks pages at explicit breaks.
 */
import { paginateDocPages } from './docPagination';

const TWIPS_PER_PX = 15;
/** How far past the last matched paragraph a rendered paragraph is searched for. */
const MATCH_WINDOW = 64;
const PICTURE_CLASS = 'preview-doc-floating-picture';

export interface DocFloatingPicture {
  src: string;
  /** Offsets and size in CSS px, relative to `horizontal` / `vertical`. */
  left: number;
  top: number;
  width: number;
  height: number;
  horizontal: 'page' | 'margin';
  vertical: 'page' | 'margin' | 'paragraph';
  behindText: boolean;
  /** Index into `DocFloatingLayer.paragraphs` of the paragraph holding the anchor. */
  paragraph: number;
}

export interface DocInlinePicture {
  src: string;
  width: number;
  height: number;
  /** Index into `DocFloatingLayer.paragraphs` of the paragraph holding the picture character. */
  paragraph: number;
}

export interface DocFloatingLayer {
  /** Main-story paragraph texts (normalized) up to the last picture paragraph. */
  paragraphs: string[];
  pictures: DocFloatingPicture[];
  /** Inline pictures the renderer dropped. Empty when every picture character was painted. */
  inlinePictures: DocInlinePicture[];
  /** Default tab interval in CSS px (Word dxaTab, 48 when the file does not say). */
  tabSize: number;
  /** Paper size and margins of the first section. */
  page: DocPageSetup;
}

/** Paper size and margins in CSS px. */
export interface DocPageSetup {
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** Document grid line pitch, when the section snaps lines to a grid. */
  linePitch?: number;
}

/* ---------- Compound file (CFB) ---------- */

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** Sector ids at or above this are FAT markers (free, end of chain, …). */
const MAX_SECTOR_ID = 0xfffffffa;

class Bytes {
  readonly view: DataView;
  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  u8(offset: number): number {
    return offset >= 0 && offset < this.data.length ? this.data[offset] : 0;
  }
  u16(offset: number): number {
    return offset >= 0 && offset + 2 <= this.data.length ? this.view.getUint16(offset, true) : 0;
  }
  i16(offset: number): number {
    return offset >= 0 && offset + 2 <= this.data.length ? this.view.getInt16(offset, true) : 0;
  }
  u32(offset: number): number {
    return offset >= 0 && offset + 4 <= this.data.length ? this.view.getUint32(offset, true) : 0;
  }
  i32(offset: number): number {
    return offset >= 0 && offset + 4 <= this.data.length ? this.view.getInt32(offset, true) : 0;
  }
}

/** Returns a reader for the root-level streams of a compound file, or null if it is not one. */
function openCompoundFile(data: Uint8Array): ((name: string) => Uint8Array | null) | null {
  if (data.length < 512 || CFB_SIGNATURE.some((byte, i) => data[i] !== byte)) return null;
  const file = new Bytes(data);
  const sectorSize = 1 << file.u16(30);
  const miniSectorSize = 1 << file.u16(32);
  const miniCutoff = file.u32(56);
  const sectorOffset = (id: number): number => (id + 1) * sectorSize;

  const difat: number[] = [];
  for (let i = 0; i < 109; i++) difat.push(file.u32(76 + i * 4));
  for (let id = file.u32(68), left = file.u32(72); id < MAX_SECTOR_ID && left > 0; left--) {
    const base = sectorOffset(id);
    const perSector = sectorSize / 4 - 1;
    for (let i = 0; i < perSector; i++) difat.push(file.u32(base + i * 4));
    id = file.u32(base + perSector * 4);
  }
  const fat: number[] = [];
  for (const id of difat) {
    if (id >= MAX_SECTOR_ID) continue;
    for (let i = 0; i < sectorSize / 4; i++) fat.push(file.u32(sectorOffset(id) + i * 4));
  }

  const chain = (start: number, table: readonly number[]): number[] => {
    const ids: number[] = [];
    for (let id = start; id < MAX_SECTOR_ID && id < table.length && ids.length < table.length; id = table[id]) ids.push(id);
    return ids;
  };
  const readChain = (start: number, size: number, table: readonly number[], unit: number, source: Uint8Array, at: (id: number) => number): Uint8Array => {
    const out = new Uint8Array(size);
    let written = 0;
    for (const id of chain(start, table)) {
      if (written >= size) break;
      const from = at(id);
      const part = source.subarray(from, Math.min(from + unit, from + size - written));
      out.set(part, written);
      written += part.length;
    }
    return out.subarray(0, written);
  };
  const readRegular = (start: number, size: number): Uint8Array => readChain(start, size, fat, sectorSize, data, sectorOffset);

  const firstDirSector = file.u32(48);
  const directory = new Bytes(readRegular(firstDirSector, chain(firstDirSector, fat).length * sectorSize));
  const entryCount = Math.floor(directory.data.length / 128);
  const entry = (index: number) => {
    const base = index * 128;
    const nameBytes = Math.max(0, Math.min(64, directory.u16(base + 64)) - 2);
    return {
      name: new TextDecoder('utf-16le').decode(directory.data.subarray(base, base + nameBytes)),
      type: directory.u8(base + 66),
      left: directory.u32(base + 68),
      right: directory.u32(base + 72),
      child: directory.u32(base + 76),
      start: directory.u32(base + 116),
      size: directory.u32(base + 120),
    };
  };
  if (!entryCount) return null;
  const root = entry(0);
  const miniStream = readRegular(root.start, root.size);
  const miniFatBytes = new Bytes(readRegular(file.u32(60), file.u32(64) * sectorSize));
  const miniFat = Array.from({ length: miniFatBytes.data.length / 4 }, (_, i) => miniFatBytes.u32(i * 4));

  const streams = new Map<string, ReturnType<typeof entry>>();
  const pending = [root.child];
  const seen = new Set<number>();
  while (pending.length) {
    const index = pending.pop()!;
    if (index >= entryCount || seen.has(index)) continue;
    seen.add(index);
    const item = entry(index);
    if (item.type === 2) streams.set(item.name, item);
    pending.push(item.left, item.right);
  }

  return (name) => {
    const item = streams.get(name);
    if (!item) return null;
    return item.size < miniCutoff
      ? readChain(item.start, item.size, miniFat, miniSectorSize, miniStream, id => id * miniSectorSize)
      : readRegular(item.start, item.size);
  };
}

/* ---------- Word binary (MS-DOC) ---------- */

const FIB_PLCF_SED = 6;
const FIB_PLCF_BTE_CHPX = 12;
const FIB_DOP = 31;
const FIB_CLX = 33;
const FIB_PLC_SPA_MOM = 40;
const FIB_DGG_INFO = 50;
const DEFAULT_TAB_TWIPS = 720;
const SPRM_PIC_LOCATION = 0x6a03;
const PICF_HEADER_SIZE = 68;

interface TextPiece {
  cpStart: number;
  cpEnd: number;
  byteStart: number;
  byteEnd: number;
  compressed: boolean;
}

/** Main-story pieces and text, or null when the CLX is unreadable. */
function readPieces(word: Bytes, table: Bytes, clxOffset: number, clxSize: number, ccpText: number): { pieces: TextPiece[]; text: string } | null {
  const end = clxOffset + clxSize;
  let cursor = clxOffset;
  while (cursor < end && table.u8(cursor) === 0x01) cursor += 3 + table.u16(cursor + 1);
  if (table.u8(cursor) !== 0x02) return null;
  const plc = cursor + 5;
  const pieceCount = (table.u32(cursor + 1) - 4) / 12;
  const pieces: TextPiece[] = [];
  let text = '';
  let cp = 0;
  for (let i = 0; i < pieceCount && cp < ccpText; i++) {
    const length = table.u32(plc + (i + 1) * 4) - table.u32(plc + i * 4);
    const fc = table.u32(plc + (pieceCount + 1) * 4 + i * 8 + 2);
    const compressed = (fc & 0x40000000) !== 0;
    const start = compressed ? (fc & 0x3fffffff) / 2 : fc;
    const take = Math.max(0, Math.min(length, ccpText - cp));
    pieces.push({
      cpStart: cp,
      cpEnd: cp + length,
      byteStart: start,
      byteEnd: start + (compressed ? length : length * 2),
      compressed,
    });
    text += compressed
      ? new TextDecoder('windows-1252').decode(word.data.subarray(start, start + take))
      : new TextDecoder('utf-16le').decode(word.data.subarray(start, start + take * 2));
    cp += length;
  }
  return { pieces, text: text.slice(0, ccpText) };
}

/** File position (as stored in a CHPX page) to a character position. */
function fcToCp(pieces: readonly TextPiece[], fcRaw: number): number | null {
  const hintedCompressed = (fcRaw & 0x40000000) !== 0;
  const actual = hintedCompressed ? Math.floor((fcRaw & 0x3fffffff) / 2) : (fcRaw & 0x3fffffff);
  const match = (fc: number, compressedHint: boolean | null): number | null => {
    for (const piece of pieces) {
      if (fc < piece.byteStart || fc > piece.byteEnd) continue;
      if (compressedHint != null && compressedHint !== piece.compressed) continue;
      const delta = fc - piece.byteStart;
      const cp = piece.cpStart + Math.floor(delta / (piece.compressed ? 1 : 2));
      if (cp >= piece.cpStart && cp <= piece.cpEnd) return cp;
    }
    return null;
  };
  return match(actual, hintedCompressed) ?? match(fcRaw, null);
}

/** Operand size of one sprm, enough to walk a character-property list to the picture location. */
function sprmOperandLength(bytes: Bytes, offset: number, sprm: number): number {
  const spra = (sprm >> 13) & 7;
  if (spra === 6) return bytes.u8(offset) + 1;
  return [1, 1, 2, 4, 2, 2, 0, 3][spra] ?? 0;
}

function pictureOffsetOf(word: Bytes, chpxOffset: number): number | null {
  if (chpxOffset <= 0) return null;
  const size = word.u8(chpxOffset);
  let cursor = chpxOffset + 1;
  const end = Math.min(word.data.length, cursor + size);
  while (cursor + 2 <= end) {
    const sprm = word.u16(cursor);
    cursor += 2;
    const length = sprmOperandLength(word, cursor, sprm);
    if (!length || cursor + length > end) return null;
    if (sprm === SPRM_PIC_LOCATION) return word.u32(cursor);
    cursor += length;
  }
  return null;
}

interface ChpxRun {
  cpStart: number;
  cpEnd: number;
  chpxOffset: number;
}

function readChpxRuns(word: Bytes, table: Bytes, pieces: readonly TextPiece[], plcOffset: number, plcSize: number): ChpxRun[] {
  if (plcSize < 12) return [];
  const count = Math.floor((plcSize - 4) / 8);
  const runs: ChpxRun[] = [];
  for (let i = 0; i < count; i++) {
    const pn = table.u32(plcOffset + (count + 1) * 4 + i * 4) & 0x3fffff;
    const page = pn * 512;
    if (page + 512 > word.data.length) continue;
    const crun = word.u8(page + 511);
    if (!crun || crun > 100) continue;
    for (let run = 0; run < crun; run++) {
      const cpStart = fcToCp(pieces, word.u32(page + run * 4));
      const cpEnd = fcToCp(pieces, word.u32(page + (run + 1) * 4));
      if (cpStart == null || cpEnd == null || cpEnd <= cpStart) continue;
      const wordOffset = word.u8(page + (crun + 1) * 4 + run);
      runs.push({ cpStart, cpEnd, chpxOffset: wordOffset ? page + wordOffset * 2 : 0 });
    }
  }
  runs.sort((a, b) => a.cpStart - b.cpStart || a.cpEnd - b.cpEnd);
  return runs;
}

/** Default tab interval. dxaTab is a stable field at byte 10 of the DOP; 360 twips at byte 14 is the hot zone. */
function readTabSize(table: Bytes, offset: number, size: number): number {
  const dxa = size >= 12 ? table.u16(offset + 10) : 0;
  const twips = dxa >= 120 && dxa <= 2880 ? dxa : DEFAULT_TAB_TWIPS;
  return twips / TWIPS_PER_PX;
}

type PageTwips = Omit<DocPageSetup, 'linePitch'>;

const PAGE_SPRMS: Record<number, keyof PageTwips> = {
  0xb01f: 'width',
  0xb020: 'height',
  0xb021: 'left',
  0xb022: 'right',
  0x9023: 'top',
  0x9024: 'bottom',
};
const SPRM_S_CLM = 0x5032;
const SPRM_S_DYA_LINE_PITCH = 0x9031;

/** Word's section defaults in twips: Letter paper, 1" top and bottom, 1.25" side margins. */
const DEFAULT_PAGE_TWIPS: PageTwips = { width: 12240, height: 15840, top: 1440, right: 1800, bottom: 1440, left: 1800 };

/** Paper size, margins and line grid of the first section (its SEPX), over Word's defaults. */
function readPageSetup(word: Bytes, table: Bytes, offset: number, size: number): DocPageSetup {
  const twips = { ...DEFAULT_PAGE_TWIPS };
  let grid = 0;
  let linePitch = 0;
  const sections = (size - 4) / 16;
  const fcSepx = Number.isInteger(sections) && sections > 0 ? table.u32(offset + (sections + 1) * 4 + 2) : 0xffffffff;
  if (fcSepx !== 0xffffffff) {
    const end = Math.min(word.data.length, fcSepx + 2 + word.u16(fcSepx));
    for (let cursor = fcSepx + 2; cursor + 2 <= end;) {
      const sprm = word.u16(cursor);
      cursor += 2;
      const length = sprmOperandLength(word, cursor, sprm);
      if (!length || cursor + length > end) break;
      const field = PAGE_SPRMS[sprm];
      // Negative top/bottom margins are exact (text may not push them); the size is the same.
      if (field) twips[field] = Math.abs(field === 'top' || field === 'bottom' ? word.i16(cursor) : word.u16(cursor));
      else if (sprm === SPRM_S_CLM) grid = word.u16(cursor);
      else if (sprm === SPRM_S_DYA_LINE_PITCH) linePitch = word.i16(cursor);
      cursor += length;
    }
  }
  const valid = twips.width >= 1440 && twips.height >= 1440
    && twips.left + twips.right < twips.width && twips.top + twips.bottom < twips.height;
  const setup = valid ? twips : DEFAULT_PAGE_TWIPS;
  return {
    width: setup.width / TWIPS_PER_PX,
    height: setup.height / TWIPS_PER_PX,
    top: setup.top / TWIPS_PER_PX,
    right: setup.right / TWIPS_PER_PX,
    bottom: setup.bottom / TWIPS_PER_PX,
    left: setup.left / TWIPS_PER_PX,
    // sprmSClm: 0 no grid; 1 chars and lines, 2 lines only, 3 chars and lines with text snapping.
    ...(grid && linePitch > 0 ? { linePitch: linePitch / TWIPS_PER_PX } : {}),
  };
}

function findMarker(bytes: Uint8Array, from: number, marker: readonly number[]): number {
  for (let i = from; i + marker.length <= bytes.length; i++) {
    if (marker.every((byte, index) => bytes[i + index] === byte)) return i + marker.length;
  }
  return -1;
}

/** PNG or JPEG stored after a PICF header. Metafiles are left to the renderer. */
function rasterInPicf(data: Uint8Array, offset: number): { mime: string; bytes: Uint8Array } | null {
  if (offset < 0 || offset + PICF_HEADER_SIZE > data.length) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lcb = view.getInt32(offset, true);
  const end = lcb > PICF_HEADER_SIZE && offset + lcb <= data.length ? offset + lcb : data.length;
  const chunk = data.subarray(offset, end);
  const pngAt = chunk.indexOf(0x89);
  for (let i = pngAt; i >= 0 && i + 8 < chunk.length; i = chunk.indexOf(0x89, i + 1)) {
    if (chunk[i + 1] !== 0x50 || chunk[i + 2] !== 0x4e || chunk[i + 3] !== 0x47) continue;
    const pngEnd = findMarker(chunk, i + 8, [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    if (pngEnd > i) return { mime: 'image/png', bytes: chunk.subarray(i, pngEnd) };
  }
  for (let i = 0; i + 3 < chunk.length; i++) {
    if (chunk[i] !== 0xff || chunk[i + 1] !== 0xd8 || chunk[i + 2] !== 0xff) continue;
    const jpegEnd = findMarker(chunk, i + 3, [0xff, 0xd9]);
    if (jpegEnd > i) return { mime: 'image/jpeg', bytes: chunk.subarray(i, jpegEnd) };
  }
  return null;
}

/** Display size Word uses for an inline picture (PICMID goal × scale, in CSS px). */
function picfDisplaySize(data: Uint8Array, offset: number): { width: number; height: number } | null {
  if (offset < 0 || offset + PICF_HEADER_SIZE > data.length) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const scaled = (goal: number, permille: number): number => (goal > 0 && permille > 0
    ? Math.max(15, Math.min(31680, Math.round((goal * permille) / 1000))) / TWIPS_PER_PX
    : 0);
  const width = scaled(view.getInt16(offset + 28, true), view.getUint16(offset + 32, true));
  const height = scaled(view.getInt16(offset + 30, true), view.getUint16(offset + 34, true));
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Paragraph text as rendered: field codes dropped, control characters and whitespace removed. */
export function normalizeDocParagraphText(raw: string): string {
  const fields: Array<'code' | 'result'> = [];
  let visible = '';
  for (const ch of raw) {
    if (ch === '\u0013') fields.push('code');
    else if (ch === '\u0014') fields[fields.length - 1] = 'result';
    else if (ch === '\u0015') fields.pop();
    else if (fields.every(part => part === 'result')) visible += ch;
  }
  return visible.replace(/[\s\p{Cc}]/gu, '');
}

interface OfficeArtRecord {
  offset: number;
  instance: number;
  type: number;
  length: number;
}

function readRecord(bytes: Bytes, offset: number): OfficeArtRecord | null {
  if (offset < 0 || offset + 8 > bytes.data.length) return null;
  const type = bytes.u16(offset + 2);
  const length = bytes.u32(offset + 4);
  if (type < 0xf000 || offset + 8 + length > bytes.data.length) return null;
  return { offset, instance: bytes.u16(offset) >> 4, type, length };
}

function* childRecords(bytes: Bytes, parent: OfficeArtRecord): Generator<OfficeArtRecord> {
  const end = parent.offset + 8 + parent.length;
  for (let cursor = parent.offset + 8; cursor < end;) {
    const record = readRecord(bytes, cursor);
    if (!record) return;
    yield record;
    cursor += 8 + record.length;
  }
}

const isContainer = (bytes: Bytes, record: OfficeArtRecord): boolean => (bytes.u16(record.offset) & 0xf) === 0xf;

interface ShapeInfo {
  blip?: number;
  posRelH?: number;
  posRelV?: number;
}

const PROP_PIB = 0x0104;
const PROP_FILL_BLIP = 0x0186;
const PROP_POS_REL_H = 0x0390;
const PROP_POS_REL_V = 0x0392;

/** BStore entries and picture shapes from the drawing data (OfficeArtContent). */
function readDrawing(table: Bytes, offset: number, size: number): { bstore: OfficeArtRecord[]; shapes: Map<number, ShapeInfo> } {
  const bstore: OfficeArtRecord[] = [];
  const shapes = new Map<number, ShapeInfo>();
  const visit = (record: OfficeArtRecord): void => {
    if (record.type === 0xf001) {
      bstore.push(...childRecords(table, record));
      return;
    }
    if (record.type === 0xf004) {
      let spid = 0;
      const info: ShapeInfo = {};
      for (const child of childRecords(table, record)) {
        if (child.type === 0xf00a) spid = table.u32(child.offset + 8);
        if (child.type !== 0xf00b && child.type !== 0xf122) continue;
        for (let i = 0; i < child.instance; i++) {
          const at = child.offset + 8 + i * 6;
          const id = table.u16(at) & 0x3fff;
          const value = table.u32(at + 2);
          if ((id === PROP_PIB || (id === PROP_FILL_BLIP && info.blip == null)) && value > 0) info.blip = value;
          else if (id === PROP_POS_REL_H) info.posRelH = value;
          else if (id === PROP_POS_REL_V) info.posRelV = value;
        }
      }
      if (spid) shapes.set(spid, info);
    }
    if (isContainer(table, record)) for (const child of childRecords(table, record)) visit(child);
  };
  // OfficeArtDggContainer, then (dgglbl byte + OfficeArtDgContainer) per drawing.
  const end = offset + size;
  for (let cursor = offset, first = true; cursor < end; first = false) {
    const record = readRecord(table, first ? cursor : cursor + 1);
    if (!record) break;
    visit(record);
    cursor = record.offset + 8 + record.length;
  }
  return { bstore, shapes };
}

const BLIP_MIME: Record<number, string> = {
  0xf01d: 'image/jpeg',
  0xf01e: 'image/png',
  0xf02a: 'image/jpeg',
};

/** Browser-renderable bytes of a BLIP record (JPEG/PNG); metafiles and DIBs are skipped. */
function blipImage(bytes: Bytes, record: OfficeArtRecord | null): { mime: string; data: Uint8Array } | null {
  const mime = record ? BLIP_MIME[record.type] : undefined;
  if (!record || !mime) return null;
  // rgbUid1 [+ rgbUid2 on odd instances] + tag byte.
  const header = 16 + (record.instance & 1 ? 16 : 0) + 1;
  return { mime, data: bytes.data.subarray(record.offset + 8 + header, record.offset + 8 + record.length) };
}

/** Resolves a 1-based BStore index to its image, embedded in the FBSE or in the delay stream. */
function bstoreImage(table: Bytes, word: Bytes, bstore: readonly OfficeArtRecord[], index: number): { mime: string; data: Uint8Array } | null {
  const fbse = bstore[index - 1];
  if (!fbse) return null;
  if (fbse.type !== 0xf007) return blipImage(table, fbse);
  const nameLength = table.u8(fbse.offset + 8 + 33);
  if (fbse.length > 36 + nameLength) return blipImage(table, readRecord(table, fbse.offset + 8 + 36 + nameLength));
  const size = table.u32(fbse.offset + 8 + 20);
  return size > 0 ? blipImage(word, readRecord(word, table.u32(fbse.offset + 8 + 28))) : null;
}

function toDataUrl(mime: string, data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(binary)}`;
}

/** Floating pictures of a binary .doc main story; null when the file is not a readable Word binary. */
export function readDocFloatingPictures(buffer: ArrayBuffer): DocFloatingLayer | null {
  const stream = openCompoundFile(new Uint8Array(buffer));
  const wordData = stream?.('WordDocument');
  if (!stream || !wordData) return null;
  const word = new Bytes(wordData);
  const flags = word.u16(10);
  if (word.u16(0) !== 0xa5ec || flags & 0x0100) return null;
  const tableData = stream(flags & 0x0200 ? '1Table' : '0Table');
  if (!tableData) return null;
  const table = new Bytes(tableData);

  let cursor = 32;
  cursor += 2 + word.u16(cursor) * 2;
  const ccpText = word.u32(cursor + 2 + 3 * 4);
  cursor += 2 + word.u16(cursor) * 4;
  const pairCount = word.u16(cursor);
  const pair = (index: number) => (index < pairCount
    ? { offset: word.u32(cursor + 2 + index * 8), size: word.u32(cursor + 2 + index * 8 + 4) }
    : { offset: 0, size: 0 });

  const spa = pair(FIB_PLC_SPA_MOM);
  const anchorCount = spa.size > 4 ? (spa.size - 4) / 30 : 0;
  const anchors = Number.isInteger(anchorCount) ? anchorCount : 0;
  const clx = pair(FIB_CLX);
  const story = readPieces(word, table, clx.offset, clx.size, ccpText);
  if (story == null) return null;
  const { pieces, text } = story;
  const dop = pair(FIB_DOP);
  const tabSize = readTabSize(table, dop.offset, dop.size);
  const sed = pair(FIB_PLCF_SED);
  const page = readPageSetup(word, table, sed.offset, sed.size);
  const dgg = pair(FIB_DGG_INFO);
  const { bstore, shapes } = anchors ? readDrawing(table, dgg.offset, dgg.size) : { bstore: [], shapes: new Map<number, ShapeInfo>() };

  const breaks: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === '\r' || text[i] === '\u0007') breaks.push(i);
  const paragraphAt = (cp: number): number => {
    const index = breaks.findIndex(end => end >= cp);
    return index < 0 ? breaks.length : index;
  };

  const pictures: DocFloatingPicture[] = [];
  for (let i = 0; i < anchors; i++) {
    const at = spa.offset + (anchors + 1) * 4 + i * 26;
    const shape = shapes.get(table.i32(at));
    const image = shape?.blip ? bstoreImage(table, word, bstore, shape.blip) : null;
    if (!image) continue;
    const left = table.i32(at + 4);
    const top = table.i32(at + 8);
    const fspaFlags = table.u16(at + 20);
    // FOPT posrelh: 0 margin, 1 page, 2 column, 3 character. FSPA bx: 0 margin, 1 page, 2 column.
    const relH = shape?.posRelH ?? (fspaFlags >> 1) & 0x3;
    // FOPT posrelv: 0 margin, 1 page, 2 paragraph, 3 line. FSPA by: 0 margin, 1 page, 2 paragraph.
    const relV = shape?.posRelV ?? (fspaFlags >> 3) & 0x3;
    pictures.push({
      src: toDataUrl(image.mime, image.data),
      left: left / TWIPS_PER_PX,
      top: top / TWIPS_PER_PX,
      width: (table.i32(at + 12) - left) / TWIPS_PER_PX,
      height: (table.i32(at + 16) - top) / TWIPS_PER_PX,
      horizontal: relH === 1 ? 'page' : 'margin',
      vertical: relV === 1 ? 'page' : relV === 0 ? 'margin' : 'paragraph',
      behindText: (fspaFlags & 0x4000) !== 0,
      paragraph: paragraphAt(table.i32(spa.offset + i * 4)),
    });
  }

  const inlinePictures: DocInlinePicture[] = [];
  const data = stream('Data');
  if (data && text.includes('\u0001')) {
    const runs = readChpxRuns(word, table, pieces, pair(FIB_PLCF_BTE_CHPX).offset, pair(FIB_PLCF_BTE_CHPX).size);
    for (let cp = 0; cp < text.length; cp++) {
      if (text[cp] !== '\u0001') continue;
      const run = runs.find(item => item.cpStart <= cp && cp < item.cpEnd);
      const pictureOffset = run ? pictureOffsetOf(word, run.chpxOffset) : null;
      if (pictureOffset == null) continue;
      const image = rasterInPicf(data, pictureOffset);
      const size = picfDisplaySize(data, pictureOffset);
      if (!image || !size) continue;
      inlinePictures.push({
        src: toDataUrl(image.mime, image.bytes),
        width: size.width,
        height: size.height,
        paragraph: paragraphAt(cp),
      });
    }
  }

  const lastParagraph = Math.max(-1, ...pictures.map(picture => picture.paragraph), ...inlinePictures.map(picture => picture.paragraph));
  const paragraphs: string[] = [];
  for (let i = 0, start = 0; i <= lastParagraph; i++) {
    const end = breaks[i] ?? text.length;
    paragraphs.push(normalizeDocParagraphText(text.slice(start, end)));
    start = end + 1;
  }
  return { paragraphs, pictures, inlinePictures, tabSize, page };
}

/* ---------- Rendered DOM ---------- */

/**
 * Pairs source paragraphs with rendered `p.msdoc-paragraph` elements in document order by text.
 * Rendered text may carry list numbers, and some files render several paragraphs in one `<p>`,
 * so a rendered paragraph that contains the source text also matches.
 */
export function matchDocParagraphs(paragraphs: readonly string[], elements: readonly Element[]): Array<Element | null> {
  const texts = elements.map(el => normalizeDocParagraphText(el.textContent ?? ''));
  let cursor = 0;
  return paragraphs.map((text) => {
    if (!text) return null;
    for (let i = cursor; i < Math.min(texts.length, cursor + MATCH_WINDOW); i++) {
      if (texts[i] === text) {
        cursor = i + 1;
        return elements[i];
      }
      if (texts[i].includes(text)) {
        cursor = i;
        return elements[i];
      }
    }
    return null;
  });
}

/** Offset of `el`'s border box from `ancestor`'s padding box, through the offsetParent chain. */
function offsetWithin(el: HTMLElement, ancestor: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let node: HTMLElement | null = el; node && node !== ancestor; node = node.offsetParent as HTMLElement | null) {
    x += node.offsetLeft;
    y += node.offsetTop;
  }
  return { x, y };
}

function px(style: CSSStyleDeclaration, name: string): number {
  return Number.parseFloat(style.getPropertyValue(name)) || 0;
}

/** Pins both axes so a host `height: auto` / `max-height` cannot squash the picture. */
function lockImageBox(img: HTMLImageElement, width: string, height: string): void {
  if (width) {
    img.style.setProperty('width', width, 'important');
    img.style.setProperty('min-width', width, 'important');
    img.style.setProperty('max-width', width, 'important');
  }
  if (height) {
    img.style.setProperty('height', height, 'important');
    img.style.setProperty('min-height', height, 'important');
    img.style.setProperty('max-height', height, 'important');
  }
  img.style.setProperty('object-fit', 'fill', 'important');
}

/** Gives the page room for a stamp that hangs below the last line, then lets the zoom layout catch up. */
function revealOverflowingPictures(root: HTMLElement): void {
  const rect = root.getBoundingClientRect();
  if (!rect.height) return;
  let overflow = 0;
  for (const img of root.querySelectorAll<HTMLElement>(`img.${PICTURE_CLASS}`)) {
    const box = img.getBoundingClientRect();
    overflow = Math.max(overflow, box.bottom - rect.bottom);
  }
  if (overflow <= 1) return;
  const pad = px(root.ownerDocument.defaultView!.getComputedStyle(root), 'padding-bottom');
  root.style.paddingBottom = `${Math.ceil(pad + overflow)}px`;
}

/**
 * Overlays each picture on its anchor paragraph (or the nearest matched one) inside `content`,
 * after restoring inline pictures and paginating, both of which move paragraphs.
 * Returns a function that stops the added pages from following the renderer's zoom.
 */
export function placeDocFloatingPictures(content: Element, layer: DocFloatingLayer): () => void {
  for (const root of content.querySelectorAll<HTMLElement>('.msdoc-root')) {
    if (layer.tabSize) {
      root.style.setProperty('tab-size', `${layer.tabSize}px`);
      root.style.setProperty('-webkit-tab-size', `${layer.tabSize}px`);
    }
    root.style.overflow = 'visible';
  }
  for (const img of content.querySelectorAll<HTMLImageElement>('img.msdoc-image')) {
    lockImageBox(img, img.style.width, img.style.height);
  }

  const elements = Array.from(content.querySelectorAll<HTMLElement>('.msdoc-root p.msdoc-paragraph'));
  const matches = matchDocParagraphs(layer.paragraphs, elements);
  const anchorFor = (index: number): HTMLElement | null => {
    for (let i = index; i < matches.length; i++) if (matches[i]) return matches[i] as HTMLElement;
    for (let i = Math.min(index, matches.length) - 1; i >= 0; i--) if (matches[i]) return matches[i] as HTMLElement;
    return elements[0] ?? null;
  };
  const painted = new Set(
    Array.from(content.querySelectorAll('img')).map(img => img.getAttribute('src')).filter((src): src is string => !!src),
  );
  for (const picture of layer.inlinePictures ?? []) {
    const paragraph = matches[picture.paragraph] as HTMLElement | null;
    if (!paragraph || painted.has(picture.src)) continue;
    const img = paragraph.ownerDocument.createElement('img');
    img.className = 'msdoc-image preview-doc-inline-picture';
    img.src = picture.src;
    img.alt = '';
    img.draggable = false;
    lockImageBox(img, `${picture.width}px`, `${picture.height}px`);
    img.style.verticalAlign = 'middle';
    paragraph.append(img);
    painted.add(picture.src);
  }
  const stopPaging = paginateDocPages(content, layer.page);
  const touched = new Set<HTMLElement>();
  for (const picture of layer.pictures) {
    const paragraph = anchorFor(picture.paragraph);
    const root = paragraph?.closest<HTMLElement>('.msdoc-root');
    const win = paragraph?.ownerDocument.defaultView;
    if (!paragraph || !root || !win) continue;
    const rootStyle = win.getComputedStyle(root);
    const offset = offsetWithin(paragraph, root);
    const left = picture.left - offset.x + (picture.horizontal === 'margin' ? px(rootStyle, 'padding-left') : 0);
    const top = picture.vertical === 'paragraph'
      ? picture.top
      : picture.top - offset.y + (picture.vertical === 'margin' ? px(rootStyle, 'padding-top') : 0);
    paragraph.style.position = 'relative';
    paragraph.style.overflow = 'visible';
    if (picture.behindText) root.style.isolation = 'isolate';
    const img = paragraph.ownerDocument.createElement('img');
    img.className = PICTURE_CLASS;
    img.src = picture.src;
    img.alt = '';
    img.draggable = false;
    img.style.position = 'absolute';
    img.style.left = `${left}px`;
    img.style.top = `${top}px`;
    lockImageBox(img, `${picture.width}px`, `${picture.height}px`);
    img.style.zIndex = picture.behindText ? '-1' : '1';
    img.style.pointerEvents = 'none';
    img.style.userSelect = 'none';
    paragraph.append(img);
    touched.add(root);
  }
  for (const root of touched) revealOverflowingPictures(root);
  return stopPaging;
}

/** Pagination measures heights: pictures without a stored size and text in loading fonts are not final before this. */
function layoutReady(stage: HTMLElement): Promise<unknown> {
  const images = Array.from(stage.querySelectorAll('img'), img => (img.complete ? null : new Promise((resolve) => {
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', resolve, { once: true });
  })));
  return Promise.all([stage.ownerDocument.fonts?.ready, ...images]);
}

/** Lays out the pages and places the pictures whenever the .doc renderer (re)builds its pages under `root`. */
export function installDocFloatingPictures(root: HTMLElement, layer: DocFloatingLayer): () => void {
  let disposed = false;
  let stopPaging: (() => void) | null = null;
  const place = (): void => {
    const stage = root.querySelector<HTMLElement>('.msdoc-stage');
    if (!stage || stage.dataset.floatingPictures) return;
    stage.dataset.floatingPictures = 'placed';
    void layoutReady(stage).then(() => {
      if (disposed || !stage.isConnected) return;
      stopPaging?.();
      stopPaging = placeDocFloatingPictures(stage, layer);
    });
  };
  const observer = new MutationObserver(place);
  observer.observe(root, { childList: true, subtree: true });
  place();
  return () => {
    disposed = true;
    observer.disconnect();
    stopPaging?.();
  };
}
