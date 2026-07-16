import { describe, expect, it } from 'vitest';

import {
  displayWidth,
  formatMarkdownTable,
  isTableSeparatorLine,
  parseInline,
  parseMarkdown,
  splitTableCells
} from './markdownParse';

describe('parseMarkdown', () => {
  it('parses headings, lists, and bold/code inline', () => {
    const lines = parseMarkdown(
      [
        '# Title',
        '',
        'Hello **world** and `code`',
        '- item one',
        '1. item two',
        '```ts',
        'const x = 1',
        '```'
      ].join('\n')
    );

    expect(lines.some((line) => line.kind === 'heading')).toBe(true);
    expect(lines.some((line) => line.kind === 'list')).toBe(true);
    expect(lines.some((line) => line.kind === 'code')).toBe(true);

    const paragraph = lines.find((line) =>
      line.spans.some((span) => span.text === 'world' && span.bold)
    );
    expect(paragraph).toBeDefined();
    expect(
      lines.some((line) => line.spans.some((span) => span.text === 'code'))
    ).toBe(true);
  });

  it('keeps incomplete fence open during streaming', () => {
    const lines = parseMarkdown('```js\nconsole.log(1)');
    expect(lines.some((line) => line.kind === 'code')).toBe(true);
  });

  it('omits the generic code label for an unlabeled fence', () => {
    const lines = parseMarkdown('```\nhello\n```');
    const codeLines = lines.filter((line) => line.kind === 'code');

    expect(codeLines[0]?.spans[0]?.text).toBe('┌────');
  });

  it('renders GFM tables as box-drawing rows', () => {
    const lines = parseMarkdown(
      [
        '| 序号 | 名称 | 状态 |',
        '|:----:|------|:----:|',
        '| 1 | 苹果 | ✅ |',
        '| 2 | 牛奶 | ❌ |',
        '3 | 面包 | ⚠️ |'
      ].join('\n')
    );

    const tableLines = lines.filter((line) => line.kind === 'table');
    expect(tableLines.length).toBeGreaterThanOrEqual(4);
    const joined = tableLines.map((line) => line.spans.map((s) => s.text).join('')).join('\n');
    expect(joined).toContain('┌');
    expect(joined).toContain('序号');
    expect(joined).toContain('苹果');
    expect(joined).toContain('面包');
    expect(joined).toContain('└');
    // 原始 pipe 分隔行不应再出现
    expect(joined).not.toMatch(/^\|.*\|$/m);
  });

  it('does not treat pipe-separated prose as a table', () => {
    const lines = parseMarkdown('用法：/mode auto|normal|conductor');
    expect(lines.every((line) => line.kind !== 'table')).toBe(true);
    expect(lines[0]?.spans.map((s) => s.text).join('')).toContain(
      '用法：/mode auto|normal|conductor'
    );
  });
});


describe('table helpers', () => {
  it('splits cells and detects separators', () => {
    expect(splitTableCells('| a | b |')).toEqual(['a', 'b']);
    expect(isTableSeparatorLine('|:---:|---|')).toBe(true);
    expect(isTableSeparatorLine('| 1 | 2 |')).toBe(false);
  });

  it('formats a minimal table', () => {
    const lines = formatMarkdownTable(['| A | B |', '|---|---|', '| 1 | 2 |']);
    expect(lines[0]?.spans[0]?.text.startsWith('┌')).toBe(true);
    expect(lines.some((line) => line.spans.some((s) => s.text.includes('A')))).toBe(
      true
    );
  });

  it('keeps table row display widths aligned with stars and CJK', () => {
    const lines = formatMarkdownTable([
      '| 水果 | 推荐 |',
      '|------|------|',
      '| 草莓 | ★★★★☆ |',
      '| 车厘子 | ★★★★★ |'
    ]);
    const dataRows = lines.filter(
      (line) =>
        line.kind === 'table' &&
        line.spans.some((span) => span.text.includes('草莓') || span.text.includes('车厘子'))
    );
    expect(dataRows.length).toBe(2);
    const widths = dataRows.map((row) =>
      displayWidth(row.spans.map((span) => span.text).join(''))
    );
    expect(widths[0]).toBe(widths[1]);
  });
});

describe('displayWidth', () => {
  it('counts ASCII and CJK correctly; stars as single width', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('草莓')).toBe(4);
    expect(displayWidth('★★★★☆')).toBe(5);
    expect(displayWidth('🌟')).toBe(2);
  });
});


describe('parseInline', () => {
  it('parses links as label plus dim url', () => {
    const spans = parseInline('see [docs](https://example.com)');
    expect(spans.some((span) => span.text === 'docs' && span.bold)).toBe(true);
    expect(
      spans.some((span) => span.text.includes('https://example.com') && span.dim)
    ).toBe(true);
  });
});
