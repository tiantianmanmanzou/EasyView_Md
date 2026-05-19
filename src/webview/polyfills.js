/**
 * Polyfills for Node.js APIs used by gray-matter and js-yaml
 * These libraries expect Buffer and process to be available
 */

import { Buffer } from 'buffer';

// Make Buffer available globally for gray-matter and js-yaml
globalThis.Buffer = Buffer;

// Minimal process polyfill for libraries that check process.browser
globalThis.process = globalThis.process || {};
globalThis.process.browser = true;

export { Buffer };
