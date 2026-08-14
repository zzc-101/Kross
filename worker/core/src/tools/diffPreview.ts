/**
 * 工具结果用 unified diff 预览（TUI 红绿背景行）。
 * - Edit 替换块：文件上下文 + -old + +new（带行号）
 * - Write 新建：全 +
 * - Write 覆盖：行级 LCS unified（带上下文与行号）
 */

export type DiffPreviewOp = 'add' | 'del' | 'meta' | 'ctx';

export interface DiffPreviewLine {
  op: DiffPreviewOp;
  text: string;
  /** 1-based 文件行号（meta 可无） */
  lineNo?: number;
}

export interface DiffHunk {
  oldStart?: number;
  newStart?: number;
  lines: DiffPreviewLine[];
}

export interface DiffPreview {
  lines: DiffPreviewLine[];
  hunks: DiffHunk[];
  truncated: boolean;
  stats: { added: number; removed: number };
}

export interface DiffPreviewOptions {
  maxLines?: number;
  maxLineChars?: number;
  maxLcsCells?: number;
  /** 变更上下保留的上下文行数，默认 3 */
  contextLines?: number;
  /**
   * 编辑发生时的完整文件内容（替换前）。
   * 提供后会在 hunk 外附加上下文，便于定位修改位置。
   */
  fileContent?: string;
}

const DEFAULT_MAX_LINES = 56;
const DEFAULT_MAX_LINE_CHARS = 200;
const DEFAULT_MAX_LCS_CELLS = 200_000;
const DEFAULT_CONTEXT_LINES = 3;

/**
 * 替换块预览。
 * - 有 fileContent：上下文 + 删除块 + 新增块 + 上下文（带行号）
 * - 无 fileContent：仅 -old / +new
 */
export function buildReplaceDiffPreview(
  oldText: string,
  newText: string,
  options?: DiffPreviewOptions
): DiffPreview {
  const maxLineChars = options?.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const contextLines = options?.contextLines ?? DEFAULT_CONTEXT_LINES;
  const fileContent = options?.fileContent;

  const oldLines = splitContentLines(oldText);
  const newLines = splitContentLines(newText);

  if (!fileContent || oldText.length === 0) {
    const removed = oldLines.map((text) => ({
      op: 'del' as const,
      text: clipLine(text, maxLineChars)
    }));
    const added = newLines.map((text) => ({
      op: 'add' as const,
      text: clipLine(text, maxLineChars)
    }));
    return finalizePreview([{ lines: [...removed, ...added] }], options);
  }

  const idx = fileContent.indexOf(oldText);
  if (idx < 0) {
    const removed = oldLines.map((text) => ({
      op: 'del' as const,
      text: clipLine(text, maxLineChars)
    }));
    const added = newLines.map((text) => ({
      op: 'add' as const,
      text: clipLine(text, maxLineChars)
    }));
    return finalizePreview([{ lines: [...removed, ...added] }], options);
  }

  const fileLines = splitContentLines(fileContent);
  const startLine = lineIndexAt(fileContent, idx); // 0-based
  const endLine = startLine + oldLines.length;

  const before = fileLines
    .slice(Math.max(0, startLine - contextLines), startLine)
    .map((text, i) => {
      const lineIndex = Math.max(0, startLine - contextLines) + i;
      return {
        op: 'ctx' as const,
        text: clipLine(text, maxLineChars),
        lineNo: lineIndex + 1
      };
    });

  const removed = oldLines.map((text, i) => ({
    op: 'del' as const,
    text: clipLine(text, maxLineChars),
    lineNo: startLine + i + 1
  }));

  // 新块占据原 start 起的行号（展示用，便于对照）
  const added = newLines.map((text, i) => ({
    op: 'add' as const,
    text: clipLine(text, maxLineChars),
    lineNo: startLine + i + 1
  }));

  // 上下文 after：原文件 endLine 之后的行，新文件中行号会因净增行位移
  const lineDelta = newLines.length - oldLines.length;
  const after = fileLines.slice(endLine, endLine + contextLines).map((text, i) => {
    const oldLineIndex = endLine + i;
    return {
      op: 'ctx' as const,
      text: clipLine(text, maxLineChars),
      // 展示新文件视角行号
      lineNo: oldLineIndex + 1 + lineDelta
    };
  });

  const lines: DiffPreviewLine[] = [...before, ...removed, ...added, ...after];
  return finalizePreview(
    [
      {
        oldStart: startLine + 1,
        newStart: startLine + 1,
        lines
      }
    ],
    options
  );
}

/** 新建文件：全是新增行 */
export function buildCreateDiffPreview(
  content: string,
  options?: DiffPreviewOptions
): DiffPreview {
  const maxLineChars = options?.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const added = splitContentLines(content).map((text, i) => ({
    op: 'add' as const,
    text: clipLine(text, maxLineChars),
    lineNo: i + 1
  }));
  if (added.length === 0) {
    const empty: DiffPreviewLine[] = [{ op: 'meta', text: '(empty file)' }];
    return {
      lines: empty,
      hunks: [{ lines: empty }],
      truncated: false,
      stats: { added: 0, removed: 0 }
    };
  }
  return finalizePreview([{ lines: added }], options);
}

/**
 * 覆盖文件：行级 LCS unified + 上下文 + 行号。
 */
export function buildOverwriteDiffPreview(
  before: string,
  after: string,
  options?: DiffPreviewOptions
): DiffPreview {
  const maxLineChars = options?.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const maxLcsCells = options?.maxLcsCells ?? DEFAULT_MAX_LCS_CELLS;
  const contextLines = options?.contextLines ?? DEFAULT_CONTEXT_LINES;
  const a = splitContentLines(before);
  const b = splitContentLines(after);

  if (a.length === 0 && b.length === 0) {
    const empty: DiffPreviewLine[] = [{ op: 'meta', text: '(empty file)' }];
    return {
      lines: empty,
      hunks: [{ lines: empty }],
      truncated: false,
      stats: { added: 0, removed: 0 }
    };
  }

  if (a.length * b.length > maxLcsCells) {
    return buildReplaceDiffPreview(before, after, {
      ...options,
      fileContent: undefined
    });
  }

  const raw = lineDiffWithContext(a, b, contextLines).map((line) => ({
    ...line,
    text: clipLine(line.text, maxLineChars)
  }));
  if (raw.length === 0) {
    const same: DiffPreviewLine[] = [
      { op: 'meta', text: '(no line changes)' }
    ];
    return {
      lines: same,
      hunks: [{ oldStart: 1, newStart: 1, lines: same }],
      truncated: false,
      stats: { added: 0, removed: 0 }
    };
  }
  return finalizePreview([{ oldStart: 1, newStart: 1, lines: raw }], options);
}

export function finalizePreview(
  hunks: DiffHunk[],
  options?: DiffPreviewOptions
): DiffPreview {
  const maxLines = options?.maxLines ?? DEFAULT_MAX_LINES;
  const flat = hunks.flatMap((h) => h.lines);
  const stats = countStats(flat);
  const truncated = balancedTruncate(flat, maxLines);
  return {
    lines: truncated.lines,
    hunks: truncated.truncated
      ? [{ lines: truncated.lines }]
      : hunks.map((h) => ({
          ...h,
          lines: h.lines.map((line) => ({ ...line }))
        })),
    truncated: truncated.truncated,
    stats
  };
}

export function countStats(lines: DiffPreviewLine[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.op === 'add') {
      added += 1;
    } else if (line.op === 'del') {
      removed += 1;
    }
  }
  return { added, removed };
}

export function balancedTruncate(
  lines: DiffPreviewLine[],
  maxLines: number
): DiffPreview {
  if (lines.length <= maxLines) {
    return {
      lines,
      hunks: [{ lines }],
      truncated: false,
      stats: countStats(lines)
    };
  }

  const hasCtx = lines.some((l) => l.op === 'ctx');
  if (hasCtx) {
    const kept = lines.slice(0, maxLines - 1);
    kept.push({
      op: 'meta',
      text: `… +${lines.length - (maxLines - 1)} more lines`
    });
    return {
      lines: kept,
      hunks: [{ lines: kept }],
      truncated: true,
      stats: countStats(lines)
    };
  }

  const dels = lines.filter((l) => l.op === 'del');
  const adds = lines.filter((l) => l.op === 'add');
  const others = lines.filter((l) => l.op !== 'del' && l.op !== 'add');

  if (dels.length > 0 && adds.length > 0 && maxLines >= 4) {
    const budget = maxLines - 1;
    const delBudget = Math.max(1, Math.floor(budget / 2));
    const addBudget = Math.max(1, budget - delBudget);
    const keptDels = dels.slice(0, delBudget);
    const keptAdds = adds.slice(0, addBudget);
    const omitted =
      dels.length -
      keptDels.length +
      (adds.length - keptAdds.length) +
      others.length;
    const result: DiffPreviewLine[] = [
      ...keptDels,
      ...keptAdds,
      { op: 'meta', text: `… +${omitted} more lines` }
    ];
    return {
      lines: result,
      hunks: [{ lines: result }],
      truncated: true,
      stats: countStats(lines)
    };
  }

  const kept = lines.slice(0, maxLines - 1);
  kept.push({
    op: 'meta',
    text: `… +${lines.length - (maxLines - 1)} more lines`
  });
  return {
    lines: kept,
    hunks: [{ lines: kept }],
    truncated: true,
    stats: countStats(lines)
  };
}

export function lineDiffUnified(
  before: string[],
  after: string[]
): DiffPreviewLine[] {
  return lineDiffWithContext(before, after, 0).filter(
    (line) => line.op === 'add' || line.op === 'del'
  );
}

/**
 * LCS 回溯 + 上下文；为每行附带 old/new 侧行号。
 */
export function lineDiffWithContext(
  before: string[],
  after: string[],
  contextLines: number
): DiffPreviewLine[] {
  type Op = {
    kind: 'eq' | 'del' | 'add';
    text: string;
    oldLine?: number;
    newLine?: number;
  };
  const ops = buildEditScript(before, after);
  if (contextLines <= 0) {
    return ops
      .filter((op) => op.kind !== 'eq')
      .map((op) =>
        op.kind === 'del'
          ? { op: 'del' as const, text: op.text, lineNo: op.oldLine }
          : { op: 'add' as const, text: op.text, lineNo: op.newLine }
      );
  }

  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i]?.kind === 'del' || ops[i]?.kind === 'add') {
      keep[i] = true;
      for (
        let j = Math.max(0, i - contextLines);
        j <= Math.min(ops.length - 1, i + contextLines);
        j += 1
      ) {
        keep[j] = true;
      }
    }
  }

  const lines: DiffPreviewLine[] = [];
  let gap = false;
  for (let i = 0; i < ops.length; i += 1) {
    if (!keep[i]) {
      gap = true;
      continue;
    }
    if (gap && lines.length > 0) {
      lines.push({ op: 'meta', text: '···' });
      gap = false;
    }
    const op = ops[i]!;
    if (op.kind === 'eq') {
      lines.push({
        op: 'ctx',
        text: op.text,
        lineNo: op.newLine ?? op.oldLine
      });
    } else if (op.kind === 'del') {
      lines.push({ op: 'del', text: op.text, lineNo: op.oldLine });
    } else {
      lines.push({ op: 'add', text: op.text, lineNo: op.newLine });
    }
  }
  return lines;
}

function buildEditScript(
  before: string[],
  after: string[]
): Array<{
  kind: 'eq' | 'del' | 'add';
  text: string;
  oldLine?: number;
  newLine?: number;
}> {
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (before[i - 1] === after[j - 1]) {
        dp[i]![j] = (dp[i - 1]![j - 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j] ?? 0, dp[i]![j - 1] ?? 0);
      }
    }
  }

  const rev: Array<{
    kind: 'eq' | 'del' | 'add';
    text: string;
    oldLine?: number;
    newLine?: number;
  }> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && before[i - 1] === after[j - 1]) {
      rev.push({
        kind: 'eq',
        text: before[i - 1] ?? '',
        oldLine: i,
        newLine: j
      });
      i -= 1;
      j -= 1;
    } else if (
      j > 0 &&
      (i === 0 || (dp[i]![j - 1] ?? 0) >= (dp[i - 1]![j] ?? 0))
    ) {
      rev.push({ kind: 'add', text: after[j - 1] ?? '', newLine: j });
      j -= 1;
    } else if (i > 0) {
      rev.push({ kind: 'del', text: before[i - 1] ?? '', oldLine: i });
      i -= 1;
    }
  }
  rev.reverse();
  return rev;
}

export function lineIndexAt(fileContent: string, index: number): number {
  if (index <= 0) {
    return 0;
  }
  let lines = 0;
  const end = Math.min(index, fileContent.length);
  for (let i = 0; i < end; i += 1) {
    if (fileContent[i] === '\n') {
      lines += 1;
    }
  }
  return lines;
}

export function splitContentLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (normalized.length === 0) {
    return [];
  }
  return normalized.split('\n');
}

function clipLine(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
