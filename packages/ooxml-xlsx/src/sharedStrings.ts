/** Parse xl/sharedStrings.xml into a flat string table. */

const SI_RE = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
const T_RE = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([\da-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(SI_RE)) {
    const parts: string[] = [];
    for (const t of match[1].matchAll(T_RE)) parts.push(decodeXmlEntities(t[1]));
    out.push(parts.join(''));
  }
  return out;
}
