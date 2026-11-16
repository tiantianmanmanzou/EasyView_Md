import { tPreview } from '../preview.i18n';

export type ImageRotation = 0 | 90 | 180 | 270;
/** Clockwise (1) or counter-clockwise (-1) quarter turn. */
export type QuarterTurn = 1 | -1;
/** Crop box as fractions (0–1) of the rotated image. */
export interface ImageCropRect { x: number; y: number; width: number; height: number }
export type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
type DrawableImage = CanvasImageSource & { width: number; height: number };

export const DEFAULT_CROP: ImageCropRect = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
const MIN_CROP = 0.02;

export function rotate(rotation: ImageRotation, turn: QuarterTurn): ImageRotation {
  return ((rotation + turn * 90 + 360) % 360) as ImageRotation;
}

/** Keeps the crop box on the same part of the picture when the picture turns. */
export function rotateCropRect(rect: ImageCropRect, turn: QuarterTurn): ImageCropRect {
  return turn === 1
    ? { x: 1 - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width }
    : { x: rect.y, y: 1 - rect.x - rect.width, width: rect.height, height: rect.width };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** `start` dragged by (dx, dy) fractions through `handle`, kept inside the picture. */
export function dragCropRect(start: ImageCropRect, handle: CropHandle, dx: number, dy: number): ImageCropRect {
  if (handle === 'move') {
    return { ...start, x: clamp(start.x + dx, 0, 1 - start.width), y: clamp(start.y + dy, 0, 1 - start.height) };
  }
  let left = start.x, top = start.y, right = start.x + start.width, bottom = start.y + start.height;
  if (handle.includes('w')) left = clamp(left + dx, 0, right - MIN_CROP);
  if (handle.includes('e')) right = clamp(right + dx, left + MIN_CROP, 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - MIN_CROP);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + MIN_CROP, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function rotatedSize(width: number, height: number, rotation: ImageRotation): { width: number; height: number } {
  return rotation % 180 === 0 ? { width, height } : { width: height, height: width };
}

export function cropPixels(rect: ImageCropRect, width: number, height: number): { x: number; y: number; width: number; height: number } {
  const x = clamp(Math.round(rect.x * width), 0, width - 1), y = clamp(Math.round(rect.y * height), 0, height - 1);
  return {
    x,
    y,
    width: clamp(Math.round((rect.x + rect.width) * width) - x, 1, width - x),
    height: clamp(Math.round((rect.y + rect.height) * height) - y, 1, height - y),
  };
}

/** Draws `source` turned by `rotation` and cut to `crop`. */
export function drawEditedImage(source: DrawableImage, rotation: ImageRotation, crop: ImageCropRect | null): HTMLCanvasElement {
  const turned = rotatedSize(source.width, source.height, rotation);
  const area = crop ? cropPixels(crop, turned.width, turned.height) : { x: 0, y: 0, ...turned };
  const canvas = document.createElement('canvas');
  canvas.width = area.width;
  canvas.height = area.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(tPreview('image.editCanvasUnavailable'));
  context.imageSmoothingQuality = 'high';
  context.translate(turned.width / 2 - area.x, turned.height / 2 - area.y);
  context.rotate((rotation * Math.PI) / 180);
  context.drawImage(source, -source.width / 2, -source.height / 2, source.width, source.height);
  return canvas;
}

export function imageMimeType(fileName: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  const name = fileName.toLowerCase();
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

export async function encodeCanvas(canvas: HTMLCanvasElement, mimeType: string): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, 0.92));
  if (!blob || blob.type !== mimeType) throw new Error(tPreview('image.encodeFailed', { type: mimeType }));
  return blob;
}
