/**
 * 轻量终端 Markdown 解析：把常见 MD 转成可着色的行/片段。
 * 面向 agent 流式输出，对未闭合 fence / 半截语法做 best-effort。
 */

export interface MdSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  /** Ink color name / hex */
  color?: string;
  inverse?: boolean;
}

export interface MdLine {
  spans: MdSpan[];
  /** 行类型，便于外层加前缀样式 */
  kind:
    | 'paragraph'
    | 'heading'
    | 'list'
    | 'quote'
    | 'code'
    | 'hr'
    | 'blank'
    | 'table';
  /** heading 级别 1–3 */
  level?: number;
}

type Align = 'left' | 'center' | 'right';

export function parseMarkdown(source: string): MdLine[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const result: MdLine[] = [];
  let inFence = false;
  let fenceLang = '';
  let index = 0;

  while (index < lines.length) {
    const raw = lines[index] ?? '';

    const fenceMatch = raw.match(/^(\s*)(```|~~~)(.*)$/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = (fenceMatch[3] ?? '').trim();
        // 始终显示代码块头部，无语言标签时用通用标记
        result.push({
          kind: 'code',
          spans: [
            {
              text: fenceLang ? `┌ ${fenceLang}` : '┌ code',
              dim: true,
              color: 'gray'
            }
          ]
        });
      } else {
        // 代码块闭合线
        result.push({
          kind: 'code',
          spans: [{ text: '└' + '─'.repeat(fenceLang ? Math.max(0, fenceLang.length + 2) : 4), dim: true, color: 'gray' }]
        });
        inFence = false;
        fenceLang = '';
      }
      index += 1;
      continue;
    }

    if (inFence) {
      result.push({
        kind: 'code',
        spans: [{ text: raw.length === 0 ? ' ' : raw, color: 'cyan' }]
      });
      index += 1;
      continue;
    }

    // GFM 表格：须以 | 开头；有分隔行，或连续 ≥2 行表行才渲染
    // 避免把「用法：/mode auto|normal|cross-repo」误识别为表
    if (isTableRowLine(raw)) {
      const tableLines: string[] = [raw];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const line = lines[cursor] ?? '';
        if (isTableRowLine(line) || isLooseTableContinuation(line)) {
          tableLines.push(normalizeTableLine(line));
          cursor += 1;
          continue;
        }
        break;
      }

      const hasSeparator =
        tableLines.length >= 2 && isTableSeparatorLine(tableLines[1] ?? '');
      if (hasSeparator || tableLines.length >= 2) {
        result.push(...formatMarkdownTable(tableLines));
        index = cursor;
        continue;
      }
    }

    if (raw.trim() === '') {
      result.push({ kind: 'blank', spans: [{ text: ' ' }] });
      index += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
      result.push({
        kind: 'hr',
        spans: [{ text: '─'.repeat(48), dim: true }]
      });
      index += 1;
      continue;
    }

    const heading = raw.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const body = heading[2] ?? '';
      result.push({
        kind: 'heading',
        level,
        spans: parseInline(body).map((span) => ({
          ...span,
          bold: true,
          color: span.color ?? (level === 1 ? 'cyan' : level === 2 ? 'blue' : undefined)
        }))
      });
      index += 1;
      continue;
    }

    const quote = raw.match(/^\s*>\s?(.*)$/);
    if (quote) {
      result.push({
        kind: 'quote',
        spans: [
          { text: '│ ', dim: true },
          ...parseInline(quote[1] ?? '').map((span) => ({ ...span, dim: true }))
        ]
      });
      index += 1;
      continue;
    }

    const ul = raw.match(/^\s*([-*+])\s+(.*)$/);
    if (ul) {
      result.push({
        kind: 'list',
        spans: [{ text: '• ', color: 'cyan' }, ...parseInline(ul[2] ?? '')]
      });
      index += 1;
      continue;
    }

    const ol = raw.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ol) {
      result.push({
        kind: 'list',
        spans: [
          { text: `${ol[1]}. `, color: 'cyan' },
          ...parseInline(ol[2] ?? '')
        ]
      });
      index += 1;
      continue;
    }

    result.push({
      kind: 'paragraph',
      spans: parseInline(raw)
    });
    index += 1;
  }

  // 未闭合的代码块（流式中常见）：补上闭合线
  if (inFence) {
    result.push({
      kind: 'code',
      spans: [{ text: '└' + '─'.repeat(fenceLang ? Math.max(0, fenceLang.length + 2) : 4), dim: true, color: 'gray' }]
    });
  }

  return result.length > 0 ? result : [{ kind: 'paragraph', spans: [{ text: '' }] }];
}

/** 标准 GFM 表行：必须以 | 开头，且至少两列 */
export function isTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) {
    return false;
  }
  // 排除单独的 hr
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
    return false;
  }
  const cells = splitTableCells(trimmed);
  return cells.length >= 2;
}

/** 分隔行：|:---|---| */
export function isTableSeparatorLine(line: string): boolean {
  const cells = splitTableCells(line.trim());
  if (cells.length < 1) {
    return false;
  }
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell.replace(/\s+/g, '')));
}

/** 表内续行：缺了开头 | 但仍有多列（模型偶发） */
export function isLooseTableContinuation(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || isTableRowLine(trimmed)) {
    return false;
  }
  return (trimmed.match(/\|/g) ?? []).length >= 2;
}

function normalizeTableLine(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('|')) {
    return trimmed;
  }
  // 补上缺失的前导 |
  return `| ${trimmed}${trimmed.endsWith('|') ? '' : ' |'}`;
}

export function splitTableCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) {
    body = body.slice(1);
  }
  if (body.endsWith('|')) {
    body = body.slice(0, -1);
  }
  return body.split('|').map((cell) => cell.trim());
}

export function parseAlignments(separatorCells: string[]): Align[] {
  return separatorCells.map((cell) => {
    const cleaned = cell.replace(/\s+/g, '');
    const left = cleaned.startsWith(':');
    const right = cleaned.endsWith(':');
    if (left && right) {
      return 'center';
    }
    if (right) {
      return 'right';
    }
    return 'left';
  });
}

/**
 * 把 MD 表格行格式化为对齐后的终端表格行（box 风格）。
 */
export function formatMarkdownTable(rawLines: string[]): MdLine[] {
  if (rawLines.length === 0) {
    return [];
  }

  const rows: string[][] = [];
  let aligns: Align[] = [];
  let start = 0;

  // header
  rows.push(splitTableCells(rawLines[0] ?? ''));

  if (rawLines.length >= 2 && isTableSeparatorLine(rawLines[1] ?? '')) {
    aligns = parseAlignments(splitTableCells(rawLines[1] ?? ''));
    start = 2;
  } else {
    start = 1;
  }

  for (let i = start; i < rawLines.length; i++) {
    rows.push(splitTableCells(rawLines[i] ?? ''));
  }

  const colCount = Math.max(...rows.map((row) => row.length), 1);
  // 对齐列数
  for (const row of rows) {
    while (row.length < colCount) {
      row.push('');
    }
  }
  while (aligns.length < colCount) {
    aligns.push('left');
  }

  // 列宽：纯文本长度（emoji 按 2 估一下不够严谨，够用）
  const widths = Array.from({ length: colCount }, (_, col) => {
    let max = 1;
    for (const row of rows) {
      max = Math.max(max, displayWidth(row[col] ?? ''));
    }
    return Math.min(max, 28); // 单列上限，避免撑爆终端
  });

  const out: MdLine[] = [];
  const border = (left: string, mid: string, right: string, fill: string): MdLine => ({
    kind: 'table',
    spans: [
      {
        text:
          left +
          widths.map((w) => fill.repeat(w + 2)).join(mid) +
          right,
        dim: true
      }
    ]
  });

  out.push(border('┌', '┬', '┐', '─'));

  // header
  out.push({
    kind: 'table',
    spans: formatTableDataRow(rows[0] ?? [], widths, aligns, true)
  });
  out.push(border('├', '┼', '┤', '─'));

  for (let r = 1; r < rows.length; r++) {
    out.push({
      kind: 'table',
      spans: formatTableDataRow(rows[r] ?? [], widths, aligns, false)
    });
  }

  out.push(border('└', '┴', '┘', '─'));
  return out;
}

function formatTableDataRow(
  cells: string[],
  widths: number[],
  aligns: Align[],
  header: boolean
): MdSpan[] {
  const spans: MdSpan[] = [{ text: '│', dim: true }];
  for (let i = 0; i < widths.length; i++) {
    const width = widths[i] ?? 1;
    const align = aligns[i] ?? 'left';
    const cell = truncateToWidth(cells[i] ?? '', width);
    const padded = padCell(cell, width, align);
    spans.push({ text: ' ' });
    spans.push({
      text: padded,
      bold: header,
      color: header ? 'cyan' : undefined
    });
    spans.push({ text: ' ' });
    spans.push({ text: '│', dim: true });
  }
  return spans;
}

/**
 * 终端显示宽度（对齐表格用）。
 * 旧实现把所有 code>0xFF 当双宽，导致 ★☆ 等被算成 2、实际占 1，右边框错位。
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += charDisplayWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}

function charDisplayWidth(code: number): number {
  // 控制符 / 零宽
  if (code === 0) {
    return 0;
  }
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
    return 0;
  }
  // 组合音标、变体选择符、ZWJ、零宽字符
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xe0100 && code <= 0xe01ef) ||
    code === 0x200d ||
    code === 0x200b ||
    code === 0x200c ||
    code === 0x200d ||
    code === 0xfeff
  ) {
    return 0;
  }

  // 宽 emoji 区块（含 🌟💰📦 等表头常用）
  if (
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x1f600 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x1fa00 && code <= 0x1faff)
  ) {
    return 2;
  }

  // 常用宽符号：部分杂项符号在 macOS Terminal 上仍是单宽（★☆）
  // 仅把明确的东亚全角 / CJK 当双宽
  if (isEastAsianWide(code)) {
    return 2;
  }

  return 1;
}

/** Unicode East Asian Wide / Fullwidth 等双宽区间（精简集） */
function isEastAsianWide(code: number): boolean {
  return (
    code === 0x3000 ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function truncateToWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) {
    return text;
  }
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = displayWidth(ch);
    if (w + cw >= width) {
      break;
    }
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

function padCell(text: string, width: number, align: Align): string {
  const w = displayWidth(text);
  const pad = Math.max(0, width - w);
  let result: string;
  if (align === 'right') {
    result = ' '.repeat(pad) + text;
  } else if (align === 'center') {
    const left = Math.floor(pad / 2);
    const right = pad - left;
    result = ' '.repeat(left) + text + ' '.repeat(right);
  } else {
    result = text + ' '.repeat(pad);
  }
  // 兜底：任何宽度误判都强制补齐/截断到目标列宽，保证右边框竖直
  const actual = displayWidth(result);
  if (actual < width) {
    return result + ' '.repeat(width - actual);
  }
  if (actual > width) {
    return truncateToWidth(result, width);
  }
  return result;
}

/**
 * 行内：`code` **bold** *italic* ~~strike~~ [label](url)
 */
export function parseInline(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  // 顺序：code → link → bold → italic → strike → plain
  const pattern =
    /(`+)([^`]*?)\1|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|(?<!\*)\*([^*]+)\*(?!\*)|(?<!_)_([^_]+)_(?!_)|~~([^~]+)~~/g;

  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      spans.push({ text: text.slice(last, match.index) });
    }

    if (match[2] !== undefined) {
      spans.push({ text: match[2], color: 'yellow', bold: true });
    } else if (match[3] !== undefined) {
      spans.push({ text: match[3], color: 'blue', bold: true });
      if (match[4]) {
        spans.push({ text: ` (${match[4]})`, dim: true });
      }
    } else if (match[5] !== undefined || match[6] !== undefined) {
      spans.push({ text: (match[5] ?? match[6]) as string, bold: true });
    } else if (match[7] !== undefined || match[8] !== undefined) {
      spans.push({ text: (match[7] ?? match[8]) as string, italic: true });
    } else if (match[9] !== undefined) {
      spans.push({ text: match[9], dim: true });
    }

    last = match.index + match[0].length;
  }

  if (last < text.length) {
    spans.push({ text: text.slice(last) });
  }

  return spans.length > 0 ? spans : [{ text: '' }];
}

/** 供视口行高估算：MD 渲染后的大致行数 */
export function estimateMarkdownRows(source: string): number {
  return Math.max(1, parseMarkdown(source).length);
}
