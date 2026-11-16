/**
 * pptx session over OpcPackage: list slides/shapes, replace shape text with
 * precise slide XML updates (untouched parts stay intact).
 */

import type { OpcPackage } from '@easyview/ooxml-core/opc';

const element = (tag: string) =>
  `<${tag}\\b(?:[^>]*?\\/>|[^>]*?[^/>]>[\\s\\S]*?<\\/${tag}>|>[\\s\\S]*?<\\/${tag}>)`;
const tags = (xml: string, tag: string) => [...xml.matchAll(new RegExp(element(tag), 'g'))].map((m) => m[0]);
const attr = (xml: string, key: string) => new RegExp(`\\b${key}="([^"]*)"`).exec(xml)?.[1] ?? '';
const decode = (text: string) =>
  text.replace(/&#x([\da-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi, (_, hex, dec, named) =>
    hex || dec
      ? String.fromCodePoint(parseInt(hex || dec, hex ? 16 : 10))
      : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named as string] ?? ''),
  );
const encode = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export interface PptxSlideInfo {
  index: number;
  id: string;
  path: string;
  relationshipId: string;
}

export interface PptxShapeText {
  slideIndex: number;
  shapeId: number;
  name: string;
  text: string;
}

interface LoadedSlide {
  originalXml: string;
  dirty: boolean;
}

function shapeBlocks(slideXml: string): Array<{ xml: string; id: number; name: string; text: string }> {
  const out: Array<{ xml: string; id: number; name: string; text: string }> = [];
  for (const sp of tags(slideXml, 'p:sp')) {
    const cNvPr = tags(sp, 'p:cNvPr')[0] ?? tags(sp, 'cNvPr')[0] ?? '';
    const id = Number(attr(cNvPr, 'id'));
    const name = decode(attr(cNvPr, 'name'));
    const texts = [...sp.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => decode(m[1]));
    if (!Number.isFinite(id)) continue;
    out.push({ xml: sp, id, name, text: texts.join('') });
  }
  return out;
}

function rewriteShapeText(shapeXml: string, text: string): string {
  const runs = [...shapeXml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)];
  if (!runs.length) {
    if (!/<p:txBody\b/.test(shapeXml)) return shapeXml;
    return shapeXml.replace(
      /<p:txBody\b([^>]*)>([\s\S]*?)<\/p:txBody>/,
      (_full, attrs: string) =>
        `<p:txBody${attrs}><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${encode(text)}</a:t></a:r></a:p></p:txBody>`,
    );
  }
  let replaced = false;
  return shapeXml.replace(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g, (full) => {
    if (!replaced) {
      replaced = true;
      return full.replace(/>[\s\S]*<\/a:t>/, `>${encode(text)}</a:t>`);
    }
    return full.replace(/>[\s\S]*<\/a:t>/, '></a:t>');
  });
}

export class PptxPresentation {
  private readonly loaded = new Map<number, LoadedSlide>();
  private constructor(
    readonly pkg: OpcPackage,
    readonly slides: PptxSlideInfo[],
  ) {}

  static async open(pkg: OpcPackage): Promise<PptxPresentation> {
    const presentationXml = await pkg.readPartText('ppt/presentation.xml');
    const relsXml = await pkg.readPartText('ppt/_rels/presentation.xml.rels');
    const relationships = new Map(
      tags(relsXml, 'Relationship').map((rel) => [attr(rel, 'Id'), attr(rel, 'Target')]),
    );
    const slides = tags(presentationXml, 'p:sldId').map((elementXml, index) => {
      const rid = attr(elementXml, 'r:id');
      const target = relationships.get(rid);
      if (!target) throw new Error(`Missing slide relationship for ${rid}`);
      const path = decodeURIComponent(new URL(target, 'https://pptx.invalid/ppt/').pathname.slice(1));
      return {
        index,
        id: attr(elementXml, 'id'),
        path: path.startsWith('ppt/') ? path : `ppt/${path}`,
        relationshipId: rid,
      };
    });
    if (!slides.length) throw new Error('Presentation has no slides');
    return new PptxPresentation(pkg, slides);
  }

  private async loadSlide(index: number): Promise<LoadedSlide> {
    const cached = this.loaded.get(index);
    if (cached) return cached;
    const info = this.slides[index];
    if (!info) throw new Error(`Unknown slide index ${index}`);
    const originalXml = await this.pkg.readPartText(info.path);
    const loaded: LoadedSlide = { originalXml, dirty: false };
    this.loaded.set(index, loaded);
    return loaded;
  }

  async listShapes(slideIndex: number): Promise<PptxShapeText[]> {
    const slide = await this.loadSlide(slideIndex);
    return shapeBlocks(slide.originalXml).map((shape) => ({
      slideIndex,
      shapeId: shape.id,
      name: shape.name,
      text: shape.text,
    }));
  }

  async summarize(maxSlides = 20): Promise<{
    slideCount: number;
    slides: Array<{ index: number; shapes: PptxShapeText[] }>;
  }> {
    const limit = Math.max(0, Math.min(this.slides.length, Math.floor(maxSlides)));
    const slides = [];
    for (let i = 0; i < limit; i += 1) {
      slides.push({ index: i, shapes: await this.listShapes(i) });
    }
    return { slideCount: this.slides.length, slides };
  }

  async setShapeText(slideIndex: number, shapeId: number, text: string): Promise<void> {
    const slide = await this.loadSlide(slideIndex);
    const blocks = shapeBlocks(slide.originalXml);
    const target = blocks.find((shape) => shape.id === shapeId);
    if (!target) throw new Error(`Shape id ${shapeId} not found on slide ${slideIndex}`);
    const nextShape = rewriteShapeText(target.xml, text);
    if (nextShape === target.xml && target.text === text) return;
    slide.originalXml = slide.originalXml.replace(target.xml, nextShape);
    slide.dirty = true;
  }

  /** Replace the first exact shape-text match on the slide (joined a:t text). */
  async replaceText(slideIndex: number, search: string, replaceWith: string): Promise<boolean> {
    if (!search) throw new Error('replaceText search must be non-empty');
    const shapes = await this.listShapes(slideIndex);
    const hit = shapes.find((shape) => shape.text.includes(search));
    if (!hit) return false;
    const next = hit.text.replace(search, replaceWith);
    await this.setShapeText(slideIndex, hit.shapeId, next);
    return true;
  }

  async flush(): Promise<string[]> {
    const dirty: string[] = [];
    for (const [index, slide] of this.loaded) {
      if (!slide.dirty) continue;
      const info = this.slides[index];
      this.pkg.writePartText(info.path, slide.originalXml);
      slide.dirty = false;
      dirty.push(info.path);
    }
    return dirty;
  }
}
