/**
 * 文件变更行数统计（Edit/Write 共用）。
 * 以「行」为单位：空串 0 行；末尾换行不额外算空行。
 */

export interface LineChangeStats {
  linesAdded: number;
  linesRemoved: number;
}

export function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (normalized.length === 0) {
    return 0;
  }
  return normalized.split('\n').length;
}

/** Edit 场景：按替换块 old/new 计行，再乘 occurrence。 */
export function hunkLineStats(
  oldText: string,
  newText: string,
  occurrences = 1
): LineChangeStats {
  const n = Math.max(1, occurrences);
  return {
    linesAdded: countLines(newText) * n,
    linesRemoved: countLines(oldText) * n
  };
}

/**
 * Write 覆盖场景：基于 LCS 的行级 diff。
 * 过大时退化为净增减，避免 O(n*m) 爆内存。
 */
export function lineDiffStats(before: string, after: string): LineChangeStats {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length === 0 && b.length === 0) {
    return { linesAdded: 0, linesRemoved: 0 };
  }
  if (a.length * b.length > 200_000) {
    return {
      linesAdded: Math.max(0, b.length - a.length),
      linesRemoved: Math.max(0, a.length - b.length)
    };
  }
  const lcs = longestCommonSubsequenceLength(a, b);
  return {
    linesAdded: b.length - lcs,
    linesRemoved: a.length - lcs
  };
}

export function formatLineDelta(stats: LineChangeStats): string {
  const { linesAdded, linesRemoved } = stats;
  if (linesAdded === 0 && linesRemoved === 0) {
    return '±0';
  }
  const parts: string[] = [];
  if (linesAdded > 0) {
    parts.push(`+${linesAdded}`);
  }
  if (linesRemoved > 0) {
    parts.push(`-${linesRemoved}`);
  }
  return parts.join(' ');
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (normalized.length === 0) {
    return [];
  }
  return normalized.split('\n');
}

function longestCommonSubsequenceLength(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return 0;
  }
  // 滚动数组 DP
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = (prev[j - 1] ?? 0) + 1;
      } else {
        curr[j] = Math.max(prev[j] ?? 0, curr[j - 1] ?? 0);
      }
    }
    const swap = prev;
    prev = curr;
    curr = swap;
    curr.fill(0);
  }
  return prev[m] ?? 0;
}
