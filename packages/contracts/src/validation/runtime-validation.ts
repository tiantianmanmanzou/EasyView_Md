export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
}

export function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
}

export function assertNonEmptyString(value: unknown, name: string): asserts value is string {
  assertString(value, name);
  if (value.trim().length === 0) throw new TypeError(`${name} must be a non-empty string`);
}

export function assertFiniteNumber(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

export function assertNonNegativeFiniteNumber(value: unknown, name: string): asserts value is number {
  assertFiniteNumber(value, name);
  if (value < 0) throw new RangeError(`${name} must be non-negative`);
}

export function assertPositiveInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

export function assertAllowedExternalUrl(value: unknown, name = 'url'): asserts value is string {
  assertNonEmptyString(value, name);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} must be a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`${name} must use http or https`);
  }
}
