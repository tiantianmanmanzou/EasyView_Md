/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  installDocFloatingPictures,
  matchDocParagraphs,
  normalizeDocParagraphText,
  placeDocFloatingPictures,
  readDocFloatingPictures,
  type DocFloatingLayer,
} from './docFloatingPictures';

const fixture = (name: string): string => resolve(process.cwd(), 'tests/fixtures/preview', name);
const load = (name: string): ArrayBuffer => {
  const bytes = readFileSync(fixture(name));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

const renderedPages = (paragraphs: string[]): string => `<div class="msdoc-stage"><section class="msdoc-page"><div class="msdoc-root">${
  paragraphs.map(text => `<p class="msdoc-paragraph">${text}</p>`).join('')
}</div></section></div>`;

const A4 = { width: 793.7, height: 1122.5, top: 96, right: 120, bottom: 96, left: 120 };

afterEach(() => {
  document.body.innerHTML = '';
});

it('reads a floating picture with its anchor paragraph, offsets and image bytes', () => {
  const layer = readDocFloatingPictures(load('floating-picture.doc'))!;
  expect(layer.paragraphs).toEqual(['Firstparagraph.', 'Secondparagraph.', 'Stampanchorparagraph.']);
  expect(layer.pictures).toHaveLength(1);
  expect(layer.inlinePictures).toEqual([]);
  expect(layer.tabSize).toBeGreaterThan(0);
  const [picture] = layer.pictures;
  expect(picture).toMatchObject({ horizontal: 'margin', vertical: 'paragraph', behindText: false, paragraph: 2 });
  // 3cm × 0.5cm offset, 4cm × 2cm frame.
  expect([picture.left, picture.top, picture.width, picture.height].map(Math.round)).toEqual([113, 19, 151, 76]);
  const png = readFileSync(fixture('sample.png')).toString('base64');
  expect(picture.src).toBe(`data:image/png;base64,${png}`);
});

it('finds no floating pictures in a .doc without shapes and rejects non-compound files', () => {
  const plain = readDocFloatingPictures(load('sample.doc'))!;
  expect(plain.paragraphs).toEqual([]);
  expect(plain.pictures).toEqual([]);
  expect(plain.inlinePictures).toEqual([]);
  expect(plain.tabSize).toBeGreaterThan(0);
  expect(readDocFloatingPictures(load('sample.docx'))).toBeNull();
});

it('reads the paper size and margins of the first section', () => {
  const round = (page: object): object => Object.fromEntries(Object.entries(page).map(([key, value]) => [key, Math.round(value as number)]));
  expect(round(readDocFloatingPictures(load('pagination.doc'))!.page)).toEqual({ width: 794, height: 1123, top: 96, right: 120, bottom: 96, left: 120 });
  expect(round(readDocFloatingPictures(load('sample.doc'))!.page)).toEqual({ width: 816, height: 1056, top: 96, right: 120, bottom: 96, left: 120 });
});

it('normalizes paragraph text like the renderer shows it', () => {
  expect(normalizeDocParagraphText('See \u0013 HYPERLINK "x" \u0014the site\u0015.\u0008\t')).toBe('Seethesite.');
});

it('matches rendered paragraphs by text, including list numbers and merged paragraphs', () => {
  document.body.innerHTML = renderedPages(['1. Intro', 'Body', 'A<br>B', 'End']);
  const elements = Array.from(document.querySelectorAll('p'));
  const matches = matchDocParagraphs(['Intro', '', 'Body', 'A', 'B', 'End'], elements);
  expect(matches.map(el => (el ? elements.indexOf(el as HTMLParagraphElement) : null))).toEqual([0, null, 1, 2, 2, 3]);
});

it('overlays each picture on its anchor paragraph, falling back to the next matched one', () => {
  document.body.innerHTML = renderedPages(['First paragraph.', 'Second paragraph.', 'Stamp anchor paragraph.', 'Last paragraph.']);
  const layer = readDocFloatingPictures(load('floating-picture.doc'))!;
  const empty: DocFloatingLayer = {
    paragraphs: ['', 'Secondparagraph.'],
    pictures: [{ ...layer.pictures[0], paragraph: 0, behindText: true }],
    inlinePictures: [],
    tabSize: 48,
    page: layer.page,
  };
  placeDocFloatingPictures(document.querySelector('.msdoc-stage')!, layer);
  placeDocFloatingPictures(document.querySelector('.msdoc-stage')!, empty);

  const [behind, stamp] = Array.from(document.querySelectorAll<HTMLImageElement>('img.preview-doc-floating-picture'));
  expect(stamp.parentElement!.textContent).toBe('Stamp anchor paragraph.');
  expect(stamp.parentElement!.style.position).toBe('relative');
  expect(stamp.style.position).toBe('absolute');
  expect(stamp.style.zIndex).toBe('1');
  expect(Math.round(Number.parseFloat(stamp.style.width))).toBe(151);
  expect(stamp.style.getPropertyPriority('width')).toBe('important');
  expect(stamp.style.getPropertyPriority('height')).toBe('important');
  expect(stamp.style.getPropertyPriority('min-height')).toBe('important');
  expect(behind.parentElement!.textContent).toBe('Second paragraph.');
  expect(behind.style.zIndex).toBe('-1');
  expect(document.querySelector<HTMLElement>('.msdoc-root')!.style.isolation).toBe('isolate');
});

it('restores a dropped inline picture, keeps one the renderer already painted, and applies the document tab interval', () => {
  document.body.innerHTML = renderedPages(['申请人签字：<img class="msdoc-image" src="data:image/png;base64,kept" style="width:79px;height:38px">', '盖章：']);
  const kept = document.querySelector<HTMLImageElement>('img.msdoc-image')!;
  const layer: DocFloatingLayer = {
    paragraphs: ['申请人签字：', '盖章：'],
    pictures: [],
    inlinePictures: [
      { src: 'data:image/png;base64,kept', width: 79, height: 38, paragraph: 0 },
      { src: 'data:image/png;base64,missing', width: 69, height: 38, paragraph: 0 },
    ],
    tabSize: 28,
    page: A4,
  };
  placeDocFloatingPictures(document.querySelector('.msdoc-stage')!, layer);
  const added = document.querySelector<HTMLImageElement>('img.preview-doc-inline-picture')!;
  expect(added.getAttribute('src')).toBe('data:image/png;base64,missing');
  expect(added.parentElement!.textContent).toContain('申请人签字');
  expect(added.style.getPropertyPriority('width')).toBe('important');
  expect(added.style.width).toBe('69px');
  expect(document.querySelectorAll('img')).toHaveLength(2);
  expect(kept.style.getPropertyPriority('height')).toBe('important');
  expect(document.querySelector<HTMLElement>('.msdoc-root')!.style.tabSize).toBe('28px');
});

it('places pictures once per render and again after the renderer rebuilds its pages', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const layer = readDocFloatingPictures(load('floating-picture.doc'))!;
  const dispose = installDocFloatingPictures(root, layer);
  const pages = ['First paragraph.', 'Second paragraph.', 'Stamp anchor paragraph.'];
  const count = (): number => root.querySelectorAll('img.preview-doc-floating-picture').length;

  root.innerHTML = renderedPages(pages);
  await vi.waitFor(() => expect(count()).toBe(1));

  root.innerHTML = renderedPages(pages);
  await vi.waitFor(() => expect(count()).toBe(1));

  dispose();
  root.innerHTML = renderedPages(pages);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(count()).toBe(0);
});
