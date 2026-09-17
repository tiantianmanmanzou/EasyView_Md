/**
 * Shared Mermaid source helpers for PDF/DOCX export.
 * Keep this file DOM-free so host and unit tests can import it.
 */

const MERMAID_START_RE =
  /^(?:flowchart|graph(?:\s+(?:TD|TB|BT|RL|LR))?|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|sankey(?:-beta)?|xychart(?:-beta)?|block(?:-beta)?|C4Context|requirementDiagram)\b/;

export function normalizeMermaidSource(source: string): string {
  return source.replace(/\r\n/g, '\n').trim();
}

export function looksLikeMermaid(source: string): boolean {
  const head = normalizeMermaidSource(source).replace(/^(?:%%[^\n]*\n)+/, '').trim();
  return MERMAID_START_RE.test(head);
}

export function isMermaidFenceInfo(info: string): boolean {
  const lang = info.trim().split(/\s+/)[0]?.toLowerCase() || '';
  return lang === 'mermaid' || lang === 'mermaidjs';
}

export function lookupMermaidMapValue<T>(source: string, map?: Map<string, T>): T | undefined {
  if (!map || map.size === 0) return undefined;
  const key = normalizeMermaidSource(source);
  const direct = map.get(key) ?? map.get(source);
  if (direct) return direct;
  for (const [stored, value] of map) {
    if (normalizeMermaidSource(stored) === key) return value;
  }
  return undefined;
}

export function extractMermaidSourcesFromMarkdown(markdown: string): string[] {
  const sources: string[] = [];
  const normalized = markdown.replace(/\r\n/g, '\n');
  const fenceRe = /^```[ \t]*([^\n`]*)\n([\s\S]*?)^```/gim;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(normalized))) {
    const info = (match[1] ?? '').trim();
    const source = normalizeMermaidSource(match[2] ?? '');
    if (!source) continue;
    if (isMermaidFenceInfo(info) || (!info && looksLikeMermaid(source))) {
      sources.push(source);
    }
  }
  return sources;
}
