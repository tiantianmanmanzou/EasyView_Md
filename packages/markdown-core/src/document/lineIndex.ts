/** UTF-16 offsets for a Markdown document. Ranges are half-open: [start, end). */
export interface LineRange {
  line: number;
  start: number;
  contentEnd: number;
  end: number;
}

export interface LineStartIndex {
  readonly content: string;
  readonly starts: readonly number[];
  lineAt(offset: number): number;
  lineStart(line: number): number;
  lineEnd(line: number): number;
  range(line: number): LineRange;
  sliceLines(startLine: number, endLine: number): string;
}

export function buildLineStartIndex(content: string): LineStartIndex {
  const starts = [0];
  for (let offset = 0; offset < content.length; offset += 1) {
    if (content.charCodeAt(offset) === 10) starts.push(offset + 1);
  }

  const lineAt = (offset: number): number => {
    const bounded = Math.max(0, Math.min(offset, content.length));
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (starts[middle] <= bounded) low = middle;
      else high = middle;
    }
    return low;
  };

  const lineStart = (line: number): number => {
    if (line < 0 || line >= starts.length) throw new RangeError(`Invalid line: ${line}`);
    return starts[line];
  };

  const lineEnd = (line: number): number => {
    const start = lineStart(line);
    const nextStart = line + 1 < starts.length ? starts[line + 1] : content.length;
    let end = nextStart;
    if (end > start && content.charCodeAt(end - 1) === 10) end -= 1;
    if (end > start && content.charCodeAt(end - 1) === 13) end -= 1;
    return end;
  };

  const range = (line: number): LineRange => {
    const start = lineStart(line);
    const contentEnd = lineEnd(line);
    return { line, start, contentEnd, end: line + 1 < starts.length ? starts[line + 1] : content.length };
  };

  return {
    content,
    starts,
    lineAt,
    lineStart,
    lineEnd,
    range,
    sliceLines: (startLine, endLine) => content.slice(lineStart(startLine), endLine < starts.length ? starts[endLine] : content.length),
  };
}
