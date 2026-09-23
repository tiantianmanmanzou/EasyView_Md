/** Exact text patches shared by the Agent runtime and editor UI. */

export interface AiTextPatch {
  description: string;
  expectedText: string;
  replacement: string;
}

interface TextPatchRange extends AiTextPatch {
  start: number;
  end: number;
}

function uniqueMatchIndex(content: string, expectedText: string): number {
  const first = content.indexOf(expectedText);
  if (first < 0) throw new Error('补丁锚点未匹配当前内容');
  if (content.indexOf(expectedText, first + expectedText.length) >= 0) {
    throw new Error('补丁锚点匹配多处，必须缩小 expectedText 的上下文');
  }
  return first;
}

/** Applies a batch only when every patch has one non-overlapping exact match. */
export function applyAiTextPatches(content: string, patches: readonly AiTextPatch[]): string {
  if (patches.length === 0) throw new Error('至少需要一个补丁');
  const ranges: TextPatchRange[] = patches.map((patch) => {
    if (!patch.description.trim()) throw new Error('补丁说明不能为空');
    if (!patch.expectedText) throw new Error('expectedText 不能为空');
    const start = uniqueMatchIndex(content, patch.expectedText);
    return { ...patch, start, end: start + patch.expectedText.length };
  });

  const ordered = [...ranges].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.start < ordered[index - 1]!.end) {
      throw new Error('补丁范围重叠，必须拆分为独立的非重叠修改');
    }
  }

  return [...ranges]
    .sort((left, right) => right.start - left.start)
    .reduce((next, patch) => `${next.slice(0, patch.start)}${patch.replacement}${next.slice(patch.end)}`, content);
}
