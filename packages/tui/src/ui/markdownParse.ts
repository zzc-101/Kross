/**
 * Markdown → 终端 MdLine：解析交给 marked，本文件只做 token → 样式行转换。
 * 表格仍渲染为 box-drawing；代码块补 header/footer，兼容流式未闭合 fence。
 */

import { Lexer, type Token, type Tokens } from 'marked';

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

const MARKED_OPTIONS = { gfm: true, breaks: false } as const;

/**
 * 将 Markdown 源解析为终端可渲染行。
 * 底层使用 marked.Lexer.lex（GFM）；转换层负责样式与表格 box 布局。
 * 注意：必须用静态 Lexer.lex，不要复用 Lexer 实例（会串 token 状态）。
 */
export function parseMarkdown(source: string): MdLine[] {
  const normalized = source.replace(/\r\n/g, '\n');
  if (normalized.length === 0) {
    return [{ kind: 'paragraph', spans: [{ text: '' }] }];
  }

  const tokens = Lexer.lex(normalized, MARKED_OPTIONS);
  const result: MdLine[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) {
      continue;
    }
    result.push(...tokenToLines(token));
  }

  return result.length > 0
    ? result
    : [{ kind: 'paragraph', spans: [{ text: '' }] }];
}

function tokenToLines(token: Token): MdLine[] {
  switch (token.type) {
    case 'space':
      return [{ kind: 'blank', spans: [{ text: ' ' }] }];

    case 'heading': {
      const heading = token as Tokens.Heading;
      const level = Math.min(3, Math.max(1, heading.depth)) as 1 | 2 | 3;
      const color = level === 1 ? 'cyan' : level === 2 ? 'blue' : undefined;
      return [
        {
          kind: 'heading',
          level,
          spans: inlineTokensToSpans(heading.tokens ?? []).map((span) => ({
            ...span,
            bold: true,
            color: span.color ?? color
          }))
        }
      ];
    }

    case 'paragraph': {
      const paragraph = token as Tokens.Paragraph;
      return [
        {
          kind: 'paragraph',
          spans: inlineTokensToSpans(paragraph.tokens ?? [])
        }
      ];
    }

    case 'text': {
      // 顶层 text 少见；list_item 内会嵌套
      const text = token as Tokens.Text;
      if (text.tokens && text.tokens.length > 0) {
        return [
          {
            kind: 'paragraph',
            spans: inlineTokensToSpans(text.tokens)
          }
        ];
      }
      return [
        {
          kind: 'paragraph',
          spans: [{ text: text.text }]
        }
      ];
    }

    case 'code': {
      const code = token as Tokens.Code;
      const lang = (code.lang ?? '').trim();
      const lines: MdLine[] = [
        {
          kind: 'code',
          spans: [
            {
              text: lang ? `┌ ${lang}` : '┌ code',
              dim: true,
              color: 'gray'
            }
          ]
        }
      ];
      const body = code.text.length === 0 ? [''] : code.text.split('\n');
      // 去掉 marked 可能保留的尾部空行
      while (body.length > 1 && body[body.length - 1] === '') {
        body.pop();
      }
      for (const row of body) {
        lines.push({
          kind: 'code',
          spans: [{ text: row.length === 0 ? ' ' : row, color: 'cyan' }]
        });
      }
      lines.push({
        kind: 'code',
        spans: [
          {
            text: '└' + '─'.repeat(lang ? Math.max(0, lang.length + 2) : 4),
            dim: true,
            color: 'gray'
          }
        ]
      });
      return lines;
    }

    case 'list': {
      const list = token as Tokens.List;
      const out: MdLine[] = [];
      let index = typeof list.start === 'number' ? list.start : 1;
      for (const item of list.items) {
        const prefix = list.ordered
          ? `${index}. `
          : item.task
            ? item.checked
              ? '☑ '
              : '☐ '
            : '• ';
        const bodySpans = listItemToSpans(item);
        out.push({
          kind: 'list',
          spans: [{ text: prefix, color: 'cyan' }, ...bodySpans]
        });
        index += 1;
      }
      return out;
    }

    case 'blockquote': {
      const quote = token as Tokens.Blockquote;
      const out: MdLine[] = [];
      for (const child of quote.tokens ?? []) {
        for (const line of tokenToLines(child)) {
          if (line.kind === 'blank') {
            out.push({
              kind: 'quote',
              spans: [{ text: '│ ', dim: true }]
            });
            continue;
          }
          out.push({
            kind: 'quote',
            spans: [
              { text: '│ ', dim: true },
              ...line.spans.map((span) => ({ ...span, dim: true }))
            ]
          });
        }
      }
      return out.length > 0
        ? out
        : [
            {
              kind: 'quote',
              spans: [{ text: '│ ', dim: true }]
            }
          ];
    }

    case 'hr':
      return [
        {
          kind: 'hr',
          spans: [{ text: '─'.repeat(48), dim: true }]
        }
      ];

    case 'table':
      return formatTableToken(token as Tokens.Table);

    case 'html': {
      const html = token as Tokens.HTML;
      const text = (html.text ?? html.raw ?? '').trim();
      if (!text) {
        return [];
      }
      return [{ kind: 'paragraph', spans: [{ text, dim: true }] }];
    }

    default:
      // 未知 token：尽量用 raw 兜底，避免吞内容
      if ('raw' in token && typeof token.raw === 'string' && token.raw.trim()) {
        return [
          {
            kind: 'paragraph',
            spans: [{ text: token.raw.trimEnd() }]
          }
        ];
      }
      return [];
  }
}

function listItemToSpans(item: Tokens.ListItem): MdSpan[] {
  const spans: MdSpan[] = [];
  for (const child of item.tokens ?? []) {
    if (child.type === 'text') {
      const text = child as Tokens.Text;
      if (text.tokens && text.tokens.length > 0) {
        spans.push(...inlineTokensToSpans(text.tokens));
      } else {
        spans.push({ text: text.text });
      }
    } else if (child.type === 'paragraph') {
      const p = child as Tokens.Paragraph;
      spans.push(...inlineTokensToSpans(p.tokens ?? []));
    } else if ('text' in child && typeof child.text === 'string') {
      spans.push({ text: child.text });
    }
  }
  return spans.length > 0 ? spans : [{ text: item.text ?? '' }];
}

function inlineTokensToSpans(tokens: Token[]): MdSpan[] {
  const spans: MdSpan[] = [];
  for (const token of tokens) {
    spans.push(...inlineTokenToSpans(token));
  }
  return spans.length > 0 ? spans : [{ text: '' }];
}

function inlineTokenToSpans(token: Token): MdSpan[] {
  switch (token.type) {
    case 'text': {
      const text = token as Tokens.Text;
      // 嵌套 tokens（list item 内的 text）
      if (text.tokens && text.tokens.length > 0) {
        return inlineTokensToSpans(text.tokens);
      }
      return [{ text: text.text }];
    }
    case 'escape': {
      const esc = token as Tokens.Escape;
      return [{ text: esc.text }];
    }
    case 'strong': {
      const strong = token as Tokens.Strong;
      return inlineTokensToSpans(strong.tokens ?? []).map((span) => ({
        ...span,
        bold: true
      }));
    }
    case 'em': {
      const em = token as Tokens.Em;
      return inlineTokensToSpans(em.tokens ?? []).map((span) => ({
        ...span,
        italic: true
      }));
    }
    case 'codespan': {
      const code = token as Tokens.Codespan;
      return [{ text: code.text, color: 'yellow', bold: true }];
    }
    case 'del': {
      const del = token as Tokens.Del;
      return inlineTokensToSpans(del.tokens ?? []).map((span) => ({
        ...span,
        dim: true
      }));
    }
    case 'link': {
      const link = token as Tokens.Link;
      const label = inlineTokensToSpans(link.tokens ?? []);
      const labeled =
        label.length > 0
          ? label.map((span) => ({
              ...span,
              bold: true,
              color: span.color ?? 'blue'
            }))
          : [{ text: link.text, bold: true, color: 'blue' as const }];
      if (link.href) {
        return [...labeled, { text: ` (${link.href})`, dim: true }];
      }
      return labeled;
    }
    case 'image': {
      const image = token as Tokens.Image;
      const alt = image.text || 'image';
      return [
        { text: alt, bold: true, color: 'blue' },
        ...(image.href ? [{ text: ` (${image.href})`, dim: true as const }] : [])
      ];
    }
    case 'br':
      return [{ text: '\n' }];
    case 'html': {
      const html = token as Tokens.HTML;
      return [{ text: html.text ?? html.raw ?? '', dim: true }];
    }
    default:
      if ('text' in token && typeof token.text === 'string') {
        return [{ text: token.text }];
      }
      if ('raw' in token && typeof token.raw === 'string') {
        return [{ text: token.raw }];
      }
      return [];
  }
}

/**
 * 行内：`code` **bold** *italic* ~~strike~~ [label](url)
 * 使用 marked 的 inline lexer，避免自研正则。
 */
export function parseInline(text: string): MdSpan[] {
  if (!text) {
    return [{ text: '' }];
  }
  const tokens = Lexer.lexInline(text, { gfm: true });
  return inlineTokensToSpans(tokens);
}

function formatTableToken(table: Tokens.Table): MdLine[] {
  const headerCells = table.header.map((cell) => cell.text ?? '');
  const aligns: Align[] = (table.align ?? []).map((a) => {
    if (a === 'center') return 'center';
    if (a === 'right') return 'right';
    return 'left';
  });
  const bodyRows = table.rows.map((row) => row.map((cell) => cell.text ?? ''));
  return formatTableCells(headerCells, bodyRows, aligns);
}

/**
 * 把 MD 表格行格式化为对齐后的终端表格行（box 风格）。
 * 保留给测试与需要手动喂行的调用方；内部优先走 marked table token。
 */
export function formatMarkdownTable(rawLines: string[]): MdLine[] {
  if (rawLines.length === 0) {
    return [];
  }
  // 走 marked 识别，保证与 parseMarkdown 一致
  const joined = rawLines.join('\n');
  const tokens = Lexer.lex(joined, MARKED_OPTIONS);
  const table = tokens.find((t) => t.type === 'table') as Tokens.Table | undefined;
  if (table) {
    return formatTableToken(table);
  }

  // fallback：手写拆分（marked 未识别时）
  const rows: string[][] = [];
  let aligns: Align[] = [];
  let start = 0;
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
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  return formatTableCells(header, body, aligns);
}

function formatTableCells(
  header: string[],
  body: string[][],
  aligns: Align[]
): MdLine[] {
  const rows = [header, ...body];
  const colCount = Math.max(...rows.map((row) => row.length), 1);
  for (const row of rows) {
    while (row.length < colCount) {
      row.push('');
    }
  }
  while (aligns.length < colCount) {
    aligns.push('left');
  }

  const widths = Array.from({ length: colCount }, (_, col) => {
    let max = 1;
    for (const row of rows) {
      max = Math.max(max, displayWidth(row[col] ?? ''));
    }
    return Math.min(max, 28);
  });

  const out: MdLine[] = [];
  const border = (
    left: string,
    mid: string,
    right: string,
    fill: string
  ): MdLine => ({
    kind: 'table',
    spans: [
      {
        text: left + widths.map((w) => fill.repeat(w + 2)).join(mid) + right,
        dim: true
      }
    ]
  });

  out.push(border('┌', '┬', '┐', '─'));
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

/** 标准 GFM 表行：必须以 | 开头，且至少两列 */
export function isTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) {
    return false;
  }
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
 * 终端显示宽度（对齐表格用）。
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += charDisplayWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}

function charDisplayWidth(code: number): number {
  if (code === 0) {
    return 0;
  }
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
    return 0;
  }
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
    code === 0xfeff
  ) {
    return 0;
  }

  if (
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x1f600 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x1fa00 && code <= 0x1faff)
  ) {
    return 2;
  }

  if (isEastAsianWide(code)) {
    return 2;
  }

  return 1;
}

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
 * 模块级 MD 解析缓存：virtual scroll / 行高估算 / 展示层共用。
 */
const PARSE_CACHE_MAX = 256;
const parseCache = new Map<string, MdLine[]>();

function parseCacheKey(source: string): string {
  if (source.length <= 256) {
    return source;
  }
  let hash = 2166136261;
  const step = Math.max(1, Math.floor(source.length / 96));
  for (let i = 0; i < source.length; i += step) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= source.charCodeAt(source.length - 1);
  return `${source.length}:${hash >>> 0}:${source.slice(0, 48)}:${source.slice(-48)}`;
}

export function cachedParseMarkdown(source: string): MdLine[] {
  const key = parseCacheKey(source);
  const hit = parseCache.get(key);
  if (hit) {
    parseCache.delete(key);
    parseCache.set(key, hit);
    return hit;
  }
  const lines = parseMarkdown(source);
  if (parseCache.size >= PARSE_CACHE_MAX) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) {
      parseCache.delete(oldest);
    }
  }
  parseCache.set(key, lines);
  return lines;
}

export function clearMarkdownParseCache(): void {
  parseCache.clear();
  streamStates.clear();
}

export function mdLineText(line: MdLine): string {
  return line.spans.map((span) => span.text).join('');
}

/**
 * 流式增量解析状态：稳定前缀只 parse 一次，每 delta 只重解析尾巴。
 * 参考 Claude Code StreamingMarkdown / marked block boundary。
 */
export interface StreamParseState {
  stablePrefix: string;
  stableLines: MdLine[];
}

const streamStates = new Map<string, StreamParseState>();

/**
 * 流式 MD 解析：按消息 key 记住稳定 block 边界。
 * 完成态（streaming=false）走全量缓存，并清掉流状态。
 */
export function parseMarkdownStreaming(
  source: string,
  streamKey: string,
  streaming: boolean
): MdLine[] {
  if (!streaming) {
    streamStates.delete(streamKey);
    return cachedParseMarkdown(source);
  }

  const normalized = source.replace(/\r\n/g, '\n');
  let state = streamStates.get(streamKey);
  if (!state || !normalized.startsWith(state.stablePrefix)) {
    state = { stablePrefix: '', stableLines: [] };
  }

  const boundary = state.stablePrefix.length;
  const tail = normalized.slice(boundary);
  // 只 lex 尾巴；用完整 tail 的 token raw 推进稳定边界
  const tailTokens = tail.length > 0 ? Lexer.lex(tail, MARKED_OPTIONS) : [];

  let lastContentIdx = tailTokens.length - 1;
  while (lastContentIdx >= 0 && tailTokens[lastContentIdx]?.type === 'space') {
    lastContentIdx -= 1;
  }

  let advance = 0;
  for (let i = 0; i < lastContentIdx; i++) {
    advance += tailTokens[i]?.raw?.length ?? 0;
  }

  if (advance > 0) {
    const newlyStable = tail.slice(0, advance);
    const newStablePrefix = state.stablePrefix + newlyStable;
    // 稳定段用全量缓存解析（immutable，可跨帧复用）
    state = {
      stablePrefix: newStablePrefix,
      stableLines: cachedParseMarkdown(newStablePrefix)
    };
  }

  const unstable = normalized.slice(state.stablePrefix.length);
  const unstableLines =
    unstable.length > 0 ? parseMarkdown(unstable) : [];

  streamStates.set(streamKey, state);

  if (state.stableLines.length === 0 && unstableLines.length === 0) {
    return [{ kind: 'paragraph', spans: [{ text: '' }] }];
  }
  // 稳定与不稳定拼接；中间不重复 blank（parseMarkdown 各自可能带尾 blank）
  return state.stableLines.concat(unstableLines);
}
