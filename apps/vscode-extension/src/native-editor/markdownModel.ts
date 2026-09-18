import * as vscode from 'vscode';

export interface HeadingInfo {
  level: number;
  text: string;
  line: number;
  anchor: string;
}

export interface LinkInfo {
  text: string;
  target: string;
  line: number;
  start: number;
  end: number;
  isImage: boolean;
}

export interface TaskInfo {
  text: string;
  line: number;
  checked: boolean;
}

export interface TableInfo {
  line: number;
  columns: number;
}

export interface MarkdownDocumentInfo {
  headings: HeadingInfo[];
  links: LinkInfo[];
  images: LinkInfo[];
  tasks: TaskInfo[];
  tables: TableInfo[];
}

export function isMarkdownDocument(document: vscode.TextDocument): boolean {
  return ['markdown', 'mdx'].includes(document.languageId)
    || /\.(md|markdown|mdx)$/i.test(document.uri.fsPath);
}

export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'heading';
}

export function stripMarkdownInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/<\/?[^>]+>/g, '')
    .trim();
}

export function parseMarkdownDocument(document: vscode.TextDocument): MarkdownDocumentInfo {
  const headings: HeadingInfo[] = [];
  const links: LinkInfo[] = [];
  const images: LinkInfo[] = [];
  const tasks: TaskInfo[] = [];
  const tables: TableInfo[] = [];
  const anchorCounts = new Map<string, number>();

  for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex++) {
    const line = document.lineAt(lineIndex);
    const text = line.text;

    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(text);
    if (headingMatch) {
      const headingText = stripMarkdownInline(headingMatch[2]);
      const baseAnchor = slugifyHeading(headingText);
      const count = anchorCounts.get(baseAnchor) ?? 0;
      anchorCounts.set(baseAnchor, count + 1);
      headings.push({
        level: headingMatch[1].length,
        text: headingText,
        line: lineIndex,
        anchor: count > 0 ? `${baseAnchor}-${count}` : baseAnchor,
      });
    }

    const taskMatch = /^(\s*[-*+]\s+)\[([ xX])\]\s+(.+)$/.exec(text);
    if (taskMatch) {
      tasks.push({
        text: stripMarkdownInline(taskMatch[3]),
        line: lineIndex,
        checked: taskMatch[2].toLowerCase() === 'x',
      });
    }

    if (/^\s*\|(.+\|)+\s*$/.test(text)) {
      tables.push({
        line: lineIndex,
        columns: Math.max(1, text.split('|').length - 2),
      });
    }

    for (const match of text.matchAll(/(!)?\[([^\]]*)\]\(([^)]+)\)/g)) {
      const start = match.index ?? 0;
      const item: LinkInfo = {
        text: match[2] || match[3],
        target: match[3],
        line: lineIndex,
        start,
        end: start + match[0].length,
        isImage: Boolean(match[1]),
      };
      if (item.isImage) {
        images.push(item);
      } else {
        links.push(item);
      }
    }
  }

  return { headings, links, images, tasks, tables };
}

export function activeMarkdownEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor && isMarkdownDocument(editor.document) ? editor : undefined;
}
