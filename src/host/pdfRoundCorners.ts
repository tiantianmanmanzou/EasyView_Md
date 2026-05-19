import { PDFDocument, PDFName } from 'pdf-lib';
import * as zlib from 'zlib';

const TOLERANCE = 3.0;
const DEFAULT_RADIUS = 6.0;
const DEFAULT_IMAGE_RADIUS = 8.0;
const MIN_IMAGE_SIZE = 100;
const PAGE_BG = [1.0, 1.0, 1.0];
const KAPPA = 0.5522847498;

// =============================================================================
// Types
// =============================================================================

interface Segment {
  x1: number; y1: number; x2: number; y2: number;
  horizontal: boolean;
  moveIdx: number; lineToIdx: number;
  strokeColor: number[] | null;
  lineWidth: number;
  gsName: string | null;
}

interface FilledRect {
  x: number; y: number; w: number; h: number;
  color: number[];
}

interface ImageInfo {
  name: string;
  x: number; y: number; w: number; h: number;
  cmIdx: number; doIdx: number;
  a: number; d: number; e: number; f: number;
}

interface BBox {
  xMin: number; yMin: number; xMax: number; yMax: number;
}

interface PreciseCorner {
  t: string; x: number; y: number; hasH: boolean; hasV: boolean;
}

// =============================================================================
// Parsing
// =============================================================================

function parseLineSegments(contentStr: string): Segment[] {
  const lines = contentStr.split("\n");
  const segments: Segment[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(/^([\d.]+)\s+([\d.]+)\s+m$/);
    if (!m) continue;
    const [x1, y1] = [parseFloat(m[1]), parseFloat(m[2])];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j >= lines.length) continue;
    const l = lines[j].trim().match(/^([\d.]+)\s+([\d.]+)\s+l$/);
    if (!l) continue;
    const [x2, y2] = [parseFloat(l[1]), parseFloat(l[2])];
    const isH = Math.abs(y1 - y2) < TOLERANCE;
    const isV = Math.abs(x1 - x2) < TOLERANCE;
    const len = isH ? Math.abs(x2 - x1) : isV ? Math.abs(y2 - y1) : 0;
    if (!(isH || isV) || len <= 15) continue;

    let strokeColor: number[] | null = null, lineWidth: number | null = null, gsName: string | null = null;
    for (let k = j + 1; k < Math.min(j + 6, lines.length); k++) {
      const fwd = lines[k].trim();
      const sc = fwd.match(/^([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+SCN$/);
      if (sc) strokeColor = [parseFloat(sc[1]), parseFloat(sc[2]), parseFloat(sc[3])];
      const gs = fwd.match(/^\/(Gs\d+)\s+gs$/);
      if (gs) gsName = gs[1];
      if (fwd === "S") break;
    }
    for (let k = i - 1; k >= Math.max(0, i - 10); k--) {
      const wm = lines[k].trim().match(/^([\d.]+)\s+w$/);
      if (wm) { lineWidth = parseFloat(wm[1]); break; }
    }
    segments.push({
      x1, y1, x2, y2, horizontal: isH,
      moveIdx: i, lineToIdx: j,
      strokeColor, lineWidth: lineWidth || 0.5, gsName,
    });
  }
  return segments;
}

function parseFilledRects(contentStr: string): FilledRect[] {
  const lines = contentStr.split("\n");
  const rects: FilledRect[] = [];
  for (let i = 0; i < lines.length; i++) {
    const rm = lines[i].trim().match(/^([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+re$/);
    if (!rm) continue;
    const [x, y, w, h] = [parseFloat(rm[1]), parseFloat(rm[2]), parseFloat(rm[3]), parseFloat(rm[4])];
    let fillColor: number[] | null = null, isFill = false;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const sc = lines[j].trim().match(/^([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+scn$/);
      if (sc) fillColor = [parseFloat(sc[1]), parseFloat(sc[2]), parseFloat(sc[3])];
      if (lines[j].trim() === "f") { isFill = true; break; }
    }
    if (isFill && fillColor) rects.push({ x, y, w, h, color: fillColor });
  }
  return rects;
}

function parseImages(contentStr: string): ImageInfo[] {
  const lines = contentStr.split("\n");
  const images: ImageInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cm = lines[i].trim().match(/^(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+cm$/);
    if (!cm) continue;
    const [a, b, c, d, e, f] = [1,2,3,4,5,6].map(k => parseFloat(cm[k]));
    if (b !== 0 || c !== 0 || Math.abs(a) < MIN_IMAGE_SIZE || Math.abs(d) < MIN_IMAGE_SIZE) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j >= lines.length) continue;
    const doM = lines[j].trim().match(/^\/(I\w+)\s+Do$/);
    if (!doM) continue;
    images.push({
      name: doM[1],
      x: e, y: d < 0 ? f + d : f,
      w: Math.abs(a), h: Math.abs(d),
      cmIdx: i, doIdx: j, a, d, e, f,
    });
  }
  return images;
}

// =============================================================================
// Grouping (Union-Find)
// =============================================================================

function groupIntoTables(segments: Segment[]): number[][] {
  const n = segments.length;
  if (n === 0) return [];
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const si = segments[i], sj = segments[j];
      for (const pi of [[si.x1, si.y1], [si.x2, si.y2]]) {
        for (const pj of [[sj.x1, sj.y1], [sj.x2, sj.y2]]) {
          if (Math.abs(pi[0] - pj[0]) < TOLERANCE && Math.abs(pi[1] - pj[1]) < TOLERANCE) union(i, j);
        }
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(i); }
  return [...groups.values()].filter(g => g.length >= 4);
}

// =============================================================================
// Background detection
// =============================================================================

function findInnerBg(bbox: BBox, rects: FilledRect[]): number[] | null {
  let best: number[] | null = null, bestArea = 0;
  for (const r of rects) {
    const [rx0, ry0, rx1, ry1] = [r.x, r.y, r.x + r.w, r.y + r.h];
    const ox0 = Math.max(bbox.xMin, rx0), oy0 = Math.max(bbox.yMin, ry0);
    const ox1 = Math.min(bbox.xMax, rx1), oy1 = Math.min(bbox.yMax, ry1);
    if (ox1 > ox0 && oy1 > oy0) {
      const touchesEdge =
        rx0 <= bbox.xMin + TOLERANCE || rx1 >= bbox.xMax - TOLERANCE ||
        ry0 <= bbox.yMin + TOLERANCE || ry1 >= bbox.yMax - TOLERANCE;
      if (!touchesEdge) continue;
      const overlap = (ox1 - ox0) * (oy1 - oy0);
      const bboxArea = (bbox.xMax - bbox.xMin) * (bbox.yMax - bbox.yMin);
      if (overlap > bboxArea * 0.3 && overlap > bestArea) { best = r.color; bestArea = overlap; }
    }
  }
  return best;
}

function findInnerBgAtCorner(cx: number, cy: number, radius: number, ctype: string, rects: FilledRect[], bbox: BBox): number[] | null {
  let px: number, py: number;
  const off = radius * 0.5;
  if (ctype === "tl") { px = cx + off; py = cy + off; }
  else if (ctype === "tr") { px = cx - off; py = cy + off; }
  else if (ctype === "br") { px = cx - off; py = cy - off; }
  else { px = cx + off; py = cy - off; }

  let best: number[] | null = null;
  for (const r of rects) {
    const [rx0, ry0, rx1, ry1] = [r.x, r.y, r.x + r.w, r.y + r.h];
    if (rx0 <= px && px <= rx1 && ry0 <= py && py <= ry1) {
      if (bbox) {
        const touchesEdge =
          (ctype === "tl" && rx0 <= bbox.xMin + TOLERANCE && ry0 <= bbox.yMin + TOLERANCE) ||
          (ctype === "tr" && rx1 >= bbox.xMax - TOLERANCE && ry0 <= bbox.yMin + TOLERANCE) ||
          (ctype === "br" && rx1 >= bbox.xMax - TOLERANCE && ry1 >= bbox.yMax - TOLERANCE) ||
          (ctype === "bl" && rx0 <= bbox.xMin + TOLERANCE && ry1 >= bbox.yMax - TOLERANCE);
        if (!touchesEdge) continue;
      }
      best = r.color;
    }
  }
  return best;
}

function findOuterBg(bbox: BBox, rects: FilledRect[]): number[] {
  let best: number[] | null = null, bestArea = Infinity;
  for (const r of rects) {
    const [rx0, ry0, rx1, ry1] = [r.x, r.y, r.x + r.w, r.y + r.h];
    if (rx0 <= bbox.xMin + TOLERANCE && ry0 <= bbox.yMin + TOLERANCE &&
        rx1 >= bbox.xMax - TOLERANCE && ry1 >= bbox.yMax - TOLERANCE) {
      const rArea = r.w * r.h;
      const tArea = (bbox.xMax - bbox.xMin) * (bbox.yMax - bbox.yMin);
      if (rArea > tArea * 1.05 && rArea < bestArea) { best = r.color; bestArea = rArea; }
    }
  }
  return best || PAGE_BG;
}

// =============================================================================
// Corner & clip building
// =============================================================================

const F4 = (v: number) => v.toFixed(4);
const F6 = (v: number) => v.toFixed(6);
const pyFloat = (v: number) => Number.isInteger(v) ? v.toFixed(1) : String(v);
const rgb3 = (c: number[]) => `${pyFloat(c[0])} ${pyFloat(c[1])} ${pyFloat(c[2])}`;

function buildCornerOps(cx: number, cy: number, radius: number, ctype: string, strokeColor: number[], innerBg: number[] | null, outerBg: number[], lineWidth: number, gsFill = "Gs1", gsStroke = "Gs3"): string {
  const r = radius, k = KAPPA, ext = 1.0;

  let qsx: number, qsy: number, qex: number, qey: number;
  let sx: number, sy: number, ex: number, ey: number;
  let cp1x: number, cp1y: number, cp2x: number, cp2y: number;

  if (ctype === "tl") {
    qsx = cx; qsy = cy + r;           sx = cx; sy = cy + r + ext;
    qex = cx + r; qey = cy;           ex = cx + r + ext; ey = cy;
    cp1x = cx; cp1y = cy + r * (1 - k);
    cp2x = cx + r * (1 - k); cp2y = cy;
  } else if (ctype === "tr") {
    qsx = cx - r; qsy = cy;           sx = cx - r - ext; sy = cy;
    qex = cx; qey = cy + r;           ex = cx; ey = cy + r + ext;
    cp1x = cx - r * (1 - k); cp1y = cy;
    cp2x = cx; cp2y = cy + r * (1 - k);
  } else if (ctype === "br") {
    qsx = cx; qsy = cy - r;           sx = cx; sy = cy - r - ext;
    qex = cx - r; qey = cy;           ex = cx - r - ext; ey = cy;
    cp1x = cx; cp1y = cy - r * (1 - k);
    cp2x = cx - r * (1 - k); cp2y = cy;
  } else {
    qsx = cx + r; qsy = cy;           sx = cx + r + ext; sy = cy;
    qex = cx; qey = cy - r;           ex = cx; ey = cy - r - ext;
    cp1x = cx + r * (1 - k); cp1y = cy;
    cp2x = cx; cp2y = cy - r * (1 - k);
  }

  const fwdArc = `${F6(cp1x)} ${F6(cp1y)} ${F6(cp2x)} ${F6(cp2y)} ${F6(qex)} ${F6(qey)} c`;
  const ops = ["q"];

  ops.push("/DeviceRGB cs", `${rgb3(outerBg)} scn`, `/${gsFill} gs`);
  ops.push(
    `${F6(cx)} ${F6(cy)} m`,
    `${F6(qsx)} ${F6(qsy)} l`,
    fwdArc,
    "h", "f"
  );

  ops.push("[] 0 d", "0 j", "0 J");
  ops.push(`${F6(sx)} ${F6(sy)} m`, `${F6(qsx)} ${F6(qsy)} l`,
    fwdArc,
    `${F6(ex)} ${F6(ey)} l`);
  ops.push("/DeviceRGB CS", `${rgb3(strokeColor)} SCN`, `/${gsStroke} gs`, `${lineWidth} w`, "S");
  ops.push("Q");
  return ops.join("\n");
}

function buildRoundedRectClip(x: number, y: number, w: number, h: number, r: number): string {
  const k = KAPPA;
  return [
    `${F4(x + r)} ${F4(y)} m`,
    `${F4(x + w - r)} ${F4(y)} l`,
    `${F4(x + w - r + r * k)} ${F4(y)} ${F4(x + w)} ${F4(y + r - r * k)} ${F4(x + w)} ${F4(y + r)} c`,
    `${F4(x + w)} ${F4(y + h - r)} l`,
    `${F4(x + w)} ${F4(y + h - r + r * k)} ${F4(x + w - r + r * k)} ${F4(y + h)} ${F4(x + w - r)} ${F4(y + h)} c`,
    `${F4(x + r)} ${F4(y + h)} l`,
    `${F4(x + r - r * k)} ${F4(y + h)} ${F4(x)} ${F4(y + h - r + r * k)} ${F4(x)} ${F4(y + h - r)} c`,
    `${F4(x)} ${F4(y + r)} l`,
    `${F4(x)} ${F4(y + r - r * k)} ${F4(x + r - r * k)} ${F4(y)} ${F4(x + r)} ${F4(y)} c`,
    "h", "W n",
  ].join("\n");
}

// =============================================================================
// Page processing
// =============================================================================

function processPageContent(contentStr: string, radius: number, imageRadius: number): { content: string; tables: number; images: number } {
  const segments = parseLineSegments(contentStr);
  const filledRects = parseFilledRects(contentStr);
  const images = parseImages(contentStr);
  const tableGroups = segments.length ? groupIntoTables(segments) : [];

  const contentLines = contentStr.split("\n");
  const mods: Record<number, string> = {};
  const arcOps: string[] = [];
  let tablesMod = 0, imagesMod = 0;

  for (const groupIdxs of tableGroups) {
    const tSegs = groupIdxs.map(i => segments[i]);
    const allX: number[] = [], allY: number[] = [];
    for (const s of tSegs) { allX.push(s.x1, s.x2); allY.push(s.y1, s.y2); }
    const bbox: BBox = { xMin: Math.min(...allX), yMin: Math.min(...allY), xMax: Math.max(...allX), yMax: Math.max(...allY) };
    if (bbox.xMax - bbox.xMin < 10 || bbox.yMax - bbox.yMin < 10) continue;

    const corners = [
      { t: "tl", x: bbox.xMin, y: bbox.yMin }, { t: "tr", x: bbox.xMax, y: bbox.yMin },
      { t: "br", x: bbox.xMax, y: bbox.yMax }, { t: "bl", x: bbox.xMin, y: bbox.yMax },
    ];

    const extSegs = tSegs.filter(s => {
      if (s.horizontal) return Math.abs(s.y1 - bbox.yMin) < TOLERANCE || Math.abs(s.y1 - bbox.yMax) < TOLERANCE;
      return Math.abs(s.x1 - bbox.xMin) < TOLERANCE || Math.abs(s.x1 - bbox.xMax) < TOLERANCE;
    });
    if (extSegs.length < 2) continue;

    const hC = extSegs.filter(s => s.horizontal && s.strokeColor).map(s => s.strokeColor!);
    const vC = extSegs.filter(s => !s.horizontal && s.strokeColor).map(s => s.strokeColor!);
    const strokeColor = hC[0] || vC[0] || [0.6, 0.6, 0.6];
    const lineW = extSegs[0].lineWidth;
    const gsStrokeName = extSegs.find(s => s.gsName)?.gsName || "Gs3";
    const innerBg = findInnerBg(bbox, filledRects);
    const outerBg = findOuterBg(bbox, filledRects);

    const preciseCorners: PreciseCorner[] = [];
    for (const c of corners) {
      const hSeg = extSegs.find(s => s.horizontal && Math.abs(s.y1 - c.y) < TOLERANCE &&
        (Math.abs(s.x1 - c.x) < TOLERANCE || Math.abs(s.x2 - c.x) < TOLERANCE));
      const vSeg = extSegs.find(s => !s.horizontal && Math.abs(s.x1 - c.x) < TOLERANCE &&
        (Math.abs(s.y1 - c.y) < TOLERANCE || Math.abs(s.y2 - c.y) < TOLERANCE));
      preciseCorners.push({ t: c.t, x: vSeg ? vSeg.x1 : c.x, y: hSeg ? hSeg.y1 : c.y, hasH: !!hSeg, hasV: !!vSeg });
    }

    for (const seg of extSegs) {
      let { x1, y1, x2, y2 } = seg;
      let nx1 = x1, ny1 = y1, nx2 = x2, ny2 = y2;
      for (const c of preciseCorners) {
        if (!c.hasH || !c.hasV) continue;
        if (Math.abs(x1 - c.x) < TOLERANCE && Math.abs(y1 - c.y) < TOLERANCE) {
          if (seg.horizontal) nx1 = x2 > x1 ? c.x + radius : c.x - radius;
          else ny1 = y2 > y1 ? c.y + radius : c.y - radius;
        }
        if (Math.abs(x2 - c.x) < TOLERANCE && Math.abs(y2 - c.y) < TOLERANCE) {
          if (seg.horizontal) nx2 = x2 > x1 ? c.x - radius : c.x + radius;
          else ny2 = y2 > y1 ? c.y - radius : c.y + radius;
        }
      }
      if (nx1 !== x1 || ny1 !== y1 || nx2 !== x2 || ny2 !== y2) {
        const indM = (contentLines[seg.moveIdx].match(/^(\s*)/) || ["", ""])[1];
        const indL = (contentLines[seg.lineToIdx].match(/^(\s*)/) || ["", ""])[1];
        mods[seg.moveIdx] = `${indM}${nx1.toFixed(6)} ${ny1.toFixed(6)} m`;
        mods[seg.lineToIdx] = `${indL}${nx2.toFixed(6)} ${ny2.toFixed(6)} l`;
      }
    }

    for (const c of preciseCorners) {
      if (c.hasH && c.hasV) {
        const cInner = findInnerBgAtCorner(c.x, c.y, radius, c.t, filledRects, bbox) || innerBg;
        arcOps.push(buildCornerOps(c.x, c.y, radius, c.t, strokeColor, cInner, outerBg, lineW, "Gs1", gsStrokeName));
      }
    }
    tablesMod++;
  }

  for (const img of images) {
    if (img.w < MIN_IMAGE_SIZE || img.h < MIN_IMAGE_SIZE) continue;
    let qIdx: number | null = null;
    for (let b = img.cmIdx - 1; b >= Math.max(0, img.cmIdx - 5); b--) {
      if (contentLines[b].trim() === "q") { qIdx = b; break; }
    }
    if (qIdx !== null) {
      const { a, d, e, f } = img;
      const [ix, iy, iw, ih] = d < 0 ? [e, f + d, a, -d] : [e, f, a, d];
      mods[qIdx] = contentLines[qIdx] + "\n" + buildRoundedRectClip(ix, iy, iw, ih, imageRadius);
      imagesMod++;
    }
  }

  if (Object.keys(mods).length === 0 && arcOps.length === 0) return { content: contentStr, tables: 0, images: 0 };

  for (const [idx, txt] of Object.entries(mods)) contentLines[parseInt(idx)] = txt;
  let result = contentLines.join("\n");
  if (arcOps.length) result += "\n" + arcOps.join("\n");
  return { content: result, tables: tablesMod, images: imagesMod };
}

// =============================================================================
// PDF I/O via pdf-lib
// =============================================================================

function decodeStream(stream: any): string | null {
  if (!stream || !stream.getContents) return null;
  const raw = Buffer.from(stream.getContents());
  const filter = stream.dict ? stream.dict.get(PDFName.of("Filter")) : null;
  // Try to decompress FlateDecode streams; fall back to raw bytes
  try { return zlib.inflateSync(raw).toString("latin1"); } catch { /* not compressed */ }
  return raw.toString("latin1");
}

function extractContentStream(page: any, pdfDoc: PDFDocument): string | null {
  const contentsRef = page.node.get(PDFName.of("Contents"));
  if (!contentsRef) return null;
  const obj = (pdfDoc as any).context.lookup(contentsRef);
  if (!obj) return null;

  if (typeof obj.size === "function") {
    let combined = "";
    for (let i = 0; i < obj.size(); i++) {
      const stream = (pdfDoc as any).context.lookup(obj.get(i));
      const text = decodeStream(stream);
      if (text) combined += text + "\n";
    }
    return combined;
  }
  return decodeStream(obj);
}

function replaceContentStream(page: any, pdfDoc: PDFDocument, newContent: string): void {
  const newBytes = Buffer.from(newContent, "latin1");
  const stream = (pdfDoc as any).context.flateStream(newBytes);
  page.node.set(PDFName.of("Contents"), (pdfDoc as any).context.register(stream));
}

/**
 * Post-process PDF bytes: round table corners and add rounded clip paths to images.
 * Takes raw PDF bytes (Uint8Array or Buffer) and returns processed PDF bytes.
 */
export async function roundPdfCorners(
  inputBytes: Uint8Array,
  radius: number = DEFAULT_RADIUS,
  imageRadius: number = DEFAULT_IMAGE_RADIUS
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(inputBytes);
  const pages = pdfDoc.getPages();

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    try {
      const contentStr = extractContentStream(page, pdfDoc);
      if (!contentStr) continue;

      const { content, tables, images } = processPageContent(contentStr, radius, imageRadius);

      if (tables > 0 || images > 0) {
        replaceContentStream(page, pdfDoc, content);
      }
    } catch (_) {
      // Skip pages that fail to process
    }
  }

  return await pdfDoc.save();
}
