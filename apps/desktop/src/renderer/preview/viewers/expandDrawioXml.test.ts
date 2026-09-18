/** @vitest-environment happy-dom */
import { deflateRaw } from 'pako';
import { describe, expect, it } from 'vitest';
import { expandDrawioXml } from './expandDrawioXml';

function compressDrawioModel(xml: string): string {
  const encoded = encodeURIComponent(xml);
  const bytes = deflateRaw(encoded);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]!);
  return btoa(binary);
}

describe('expandDrawioXml', () => {
  it('expands compressed diagram payloads into mxGraphModel', () => {
    const model = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel>';
    const source = `<mxfile><diagram id="page-1" name="Page-1">${compressDrawioModel(model)}</diagram></mxfile>`;
    const expanded = expandDrawioXml(source);
    expect(expanded).toContain('<mxGraphModel');
    expect(expanded).toContain('value="A"');
    expect(expanded).not.toMatch(/<diagram[^>]*>[A-Za-z0-9+/=]{32,}/);
  });

  it('leaves already-expanded diagrams unchanged', () => {
    const source = '<mxfile><diagram id="page-1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';
    expect(expandDrawioXml(source)).toContain('<mxGraphModel');
  });
});
