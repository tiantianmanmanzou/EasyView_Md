import { describe, expect, it } from 'vitest';
import { cropPixels, dragCropRect, imageMimeType, rotate, rotateCropRect, rotatedSize } from './imageEdit';

describe('image edit geometry', () => {
  it('turns in quarter steps both ways', () => {
    expect(rotate(0, 1)).toBe(90);
    expect(rotate(270, 1)).toBe(0);
    expect(rotate(0, -1)).toBe(270);
    expect(rotatedSize(400, 300, 90)).toEqual({ width: 300, height: 400 });
    expect(rotatedSize(400, 300, 180)).toEqual({ width: 400, height: 300 });
  });

  it('keeps the crop box on the same part of the picture when it turns', () => {
    const topLeft = { x: 0, y: 0, width: 0.5, height: 0.25 };
    // Clockwise: the top-left corner ends up top-right.
    expect(rotateCropRect(topLeft, 1)).toEqual({ x: 0.75, y: 0, width: 0.25, height: 0.5 });
    // Counter-clockwise: it ends up bottom-left.
    expect(rotateCropRect(topLeft, -1)).toEqual({ x: 0, y: 0.5, width: 0.25, height: 0.5 });
    expect(rotateCropRect(rotateCropRect(topLeft, 1), -1)).toEqual(topLeft);
  });

  it('drags the box and its edges without leaving the picture or collapsing', () => {
    const box = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    expect(dragCropRect(box, 'move', 0.9, -0.5)).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
    expect(dragCropRect(box, 'se', 0.2, 0.1)).toEqual({ x: 0.1, y: 0.1, width: expect.closeTo(0.7), height: expect.closeTo(0.6) });
    expect(dragCropRect(box, 'nw', -1, -1)).toEqual({ x: 0, y: 0, width: expect.closeTo(0.6), height: expect.closeTo(0.6) });
    const squeezed = dragCropRect(box, 'w', 2, 0);
    expect(squeezed.x + squeezed.width).toBeCloseTo(0.6);
    expect(squeezed.width).toBeCloseTo(0.02);
    expect(dragCropRect(box, 'n', 0, 0.2)).toEqual({ x: 0.1, y: expect.closeTo(0.3), width: 0.5, height: expect.closeTo(0.3) });
  });

  it('maps the crop box to whole pixels inside the image', () => {
    expect(cropPixels({ x: 0.1, y: 0.2, width: 0.5, height: 0.5 }, 200, 100)).toEqual({ x: 20, y: 20, width: 100, height: 50 });
    expect(cropPixels({ x: 0.999, y: 0, width: 0.001, height: 1 }, 10, 10)).toEqual({ x: 9, y: 0, width: 1, height: 10 });
  });

  it('saves in the format of the file suffix', () => {
    expect(imageMimeType('a.PNG')).toBe('image/png');
    expect(imageMimeType('a.jpg')).toBe('image/jpeg');
    expect(imageMimeType('a.jpeg')).toBe('image/jpeg');
    expect(imageMimeType('a.webp')).toBe('image/webp');
  });
});
