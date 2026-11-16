import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OpcPackage } from '@easyview/ooxml-core/opc';
import { createPptxAdapter } from './adapter';
import { PptxPresentation } from './presentation';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures/preview/sample.pptx',
);

describe('PptxPresentation', () => {
  it('lists slides and shape text from the fixture', async () => {
    const pkg = await OpcPackage.open(await readFile(FIXTURE));
    const deck = await PptxPresentation.open(pkg);
    expect(deck.slides).toHaveLength(1);
    const shapes = await deck.listShapes(0);
    expect(shapes.map((shape) => shape.text)).toEqual([
      'EasyView PowerPoint',
      'PPTX fixtureSecond line',
    ]);
  });

  it('replaces shape text and keeps other zip parts byte-identical', async () => {
    const original = await readFile(FIXTURE);
    const pkg = await OpcPackage.open(original);
    const beforeDigests = await pkg.partDigests();
    const deck = await PptxPresentation.open(pkg);
    const title = (await deck.listShapes(0)).find((shape) => shape.name.includes('Title'));
    expect(title).toBeTruthy();
    await deck.setShapeText(0, title!.shapeId, 'EasyView Updated');
    const dirty = await deck.flush();
    expect(dirty).toEqual(['ppt/slides/slide1.xml']);

    const saved = await pkg.save();
    const after = await OpcPackage.open(saved);
    const afterDigests = await after.partDigests();
    for (const [part, digest] of beforeDigests) {
      if (part === 'ppt/slides/slide1.xml') continue;
      expect(afterDigests.get(part), part).toBe(digest);
    }
    const shapes = await (await PptxPresentation.open(after)).listShapes(0);
    expect(shapes.find((shape) => shape.shapeId === title!.shapeId)?.text).toBe('EasyView Updated');
  });

  it('adapter replaceText applies through DocumentService-style ops', async () => {
    const pkg = await OpcPackage.open(await readFile(FIXTURE));
    const adapter = createPptxAdapter();
    await adapter.apply(pkg, [
      {
        source: 'ai',
        target: { key: 'slide:0' },
        op: 'replaceText',
        args: { op: 'replaceText', slideIndex: 0, search: 'PPTX fixture', replaceWith: 'OOXML fixture' },
      },
    ]);
    const summary = (await adapter.read(pkg, { key: 'slide:0' })) as {
      shapes: Array<{ text: string }>;
    };
    expect(summary.shapes.some((shape) => shape.text.includes('OOXML fixture'))).toBe(true);
  });
});
