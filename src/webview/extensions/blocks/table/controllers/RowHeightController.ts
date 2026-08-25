export class RowHeightController {
  normalize(value: unknown, min = 36, max = 1200): number | null {
    const height = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(height) || height <= 0) return null;
    return Math.min(max, Math.max(min, Math.round(height)));
  }
}
