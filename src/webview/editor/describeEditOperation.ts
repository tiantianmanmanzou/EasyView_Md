import type { Transaction } from 'prosemirror-state';
import { ReplaceStep } from 'prosemirror-transform';

function summarizeText(text: string, max = 36): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

export function describeProseMirrorTransaction(tr: Transaction): string {
  if (!tr.docChanged) return '调整选区';

  if (tr.getMeta('addToHistory') === false) return '';

  let inserted = '';
  let deletedChars = 0;
  let structural = false;

  for (const step of tr.steps) {
    if (step instanceof ReplaceStep) {
      deletedChars += Math.max(0, step.to - step.from);
      if (step.slice.content.size > 0) {
        inserted += step.slice.content.textBetween(0, step.slice.content.size, ' ');
      } else if (step.slice.size > 0) {
        structural = true;
      }
    } else {
      structural = true;
    }
  }

  const snippet = summarizeText(inserted);
  if (snippet && deletedChars > 0) return `替换为「${snippet}」`;
  if (snippet) return `输入「${snippet}」`;
  if (deletedChars > 0) return '删除内容';
  if (structural) return '调整结构';
  return '编辑文档';
}

export function describeSourceDocChange(before: string, after: string): string {
  if (before === after) return '';
  const prefix = sharedPrefixLength(before, after);
  const suffix = sharedSuffixLength(before, after, prefix);
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const addedSnippet = summarizeText(added.replace(/\n/g, ' ↵ '));
  const removedSnippet = summarizeText(removed.replace(/\n/g, ' ↵ '));

  if (addedSnippet && removedSnippet) {
    return `替换为「${addedSnippet}」`;
  }
  if (addedSnippet) return `输入「${addedSnippet}」`;
  if (removedSnippet) return `删除「${removedSnippet}」`;
  return '编辑源码';
}

function sharedPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index++;
  return index;
}

function sharedSuffixLength(a: string, b: string, prefix: number): number {
  const aRest = a.length - prefix;
  const bRest = b.length - prefix;
  const limit = Math.min(aRest, bRest);
  let index = 0;
  while (index < limit && a[a.length - 1 - index] === b[b.length - 1 - index]) index++;
  return index;
}
