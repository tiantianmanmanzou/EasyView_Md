import { inflate, inflateRaw } from 'pako';

/**
 * diagrams.net stores many `.drawio` pages as base64(raw-deflate(encodeURIComponent(xml))).
 * The bundled SVG fallback / official sanitizer only accept an expanded mxGraphModel.
 */
function decompressDrawioPayload(encoded: string): string {
  const binary = Uint8Array.from(atob(encoded.trim()), (char) => char.charCodeAt(0));
  const asString = (bytes: Uint8Array): string => {
    let value = '';
    for (let index = 0; index < bytes.length; index += 1) value += String.fromCharCode(bytes[index]!);
    return value;
  };
  const candidates = [
    () => decodeURIComponent(inflateRaw(binary, { to: 'string' })),
    () => decodeURIComponent(inflate(binary, { to: 'string' })),
    () => inflateRaw(binary, { to: 'string' }),
    () => inflate(binary, { to: 'string' }),
    () => decodeURIComponent(asString(inflateRaw(binary))),
    () => asString(inflateRaw(binary)),
  ];
  let lastError: unknown;
  for (const attempt of candidates) {
    try {
      const expanded = attempt().replace(/\0/g, '');
      if (expanded.includes('mxGraphModel') || expanded.includes('<mxCell')) return expanded;
      lastError = new Error('decompressed payload is not an mxGraphModel');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('无法解压 Draw.io 图元数据');
}

function looksLikeXml(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('<') && !trimmed.startsWith('<![CDATA[');
}

/**
 * Expand compressed `<diagram>` payloads into inline `<mxGraphModel>` trees so
 * File Viewer's local SVG renderer can paint the file.
 */
export function expandDrawioXml(xml: string): string {
  if (typeof xml !== 'string' || !xml.trim()) return xml;
  if (!xml.includes('<diagram') && xml.includes('<mxGraphModel')) return xml;

  const parser = new DOMParser();
  const documentRef = parser.parseFromString(xml, 'application/xml');
  if (documentRef.querySelector('parsererror')) return xml;

  let changed = false;
  for (const diagram of Array.from(documentRef.querySelectorAll('diagram'))) {
    if (diagram.querySelector('mxGraphModel')) continue;
    const encoded = (diagram.textContent || '').trim();
    if (!encoded || looksLikeXml(encoded)) continue;
    try {
      const expanded = decompressDrawioPayload(encoded);
      const modelDocument = parser.parseFromString(expanded, 'application/xml');
      if (modelDocument.querySelector('parsererror')) continue;
      const model = modelDocument.querySelector('mxGraphModel') ?? modelDocument.documentElement;
      if (!model || model.localName.toLowerCase() === 'parsererror') continue;
      while (diagram.firstChild) diagram.removeChild(diagram.firstChild);
      diagram.appendChild(documentRef.importNode(model, true));
      changed = true;
    } catch {
      // Keep the original diagram node; the viewer will surface a clearer error.
    }
  }

  return changed ? new XMLSerializer().serializeToString(documentRef) : xml;
}
