import { describe, expect, it } from 'vitest';

import type { ChatMessage } from './MessageLine';
import {
  MessagePaintCache,
  paintItemPlainText,
  windowPaintRows
} from './messagePaint';
import { parseMarkdownStreaming, clearMarkdownParseCache } from './markdownParse';

function msg(
  partial: Pick<ChatMessage, 'id' | 'from' | 'text'> & Partial<ChatMessage>
): ChatMessage {
  return {
    id: partial.id,
    from: partial.from,
    text: partial.text,
    expanded: partial.expanded,
    tool: partial.tool
  };
}

describe('windowPaintRows', () => {
  it('keeps bottom slice and preserves scroll bounds', () => {
    const messages = Array.from({ length: 30 }, (_, index) =>
      msg({ id: index + 1, from: 'user', text: `line-${index}` })
    );
    const result = windowPaintRows({
      messages,
      columns: 80,
      viewportRows: 10,
      scrollOffset: 0
    });

    expect(result.totalRows).toBeGreaterThan(10);
    expect(result.maxScrollOffset).toBeGreaterThan(0);
    expect(result.hasMoreAbove).toBe(true);
    expect(result.hasMoreBelow).toBe(false);
    const plains = result.items.map(paintItemPlainText).join('\n');
    expect(plains).toContain('line-29');
  });

  it('scrolls up to reveal older messages', () => {
    const messages = Array.from({ length: 20 }, (_, index) =>
      msg({ id: index + 1, from: 'user', text: `m-${index}` })
    );
    const bottom = windowPaintRows({
      messages,
      columns: 80,
      viewportRows: 6,
      scrollOffset: 0
    });
    const scrolled = windowPaintRows({
      messages,
      columns: 80,
      viewportRows: 6,
      scrollOffset: bottom.maxScrollOffset
    });

    expect(scrolled.items.map(paintItemPlainText).join('\n')).toContain('m-0');
    expect(scrolled.hasMoreBelow).toBe(true);
  });

  it('paints agent markdown with styles (not plain-only)', () => {
    const cache = new MessagePaintCache();
    const message = msg({
      id: 1,
      from: 'agent',
      text: '# Hello\n\n**bold** and `code`\n\n| A | B |\n|---|---|\n| 1 | 2 |'
    });
    const items = cache.paintMessage(message, 80, false);
    const lines = items.filter((i) => i.kind === 'line');
    expect(lines.length).toBeGreaterThan(3);

    const hasBold = lines.some(
      (i) => i.kind === 'line' && i.segments.some((s) => s.bold)
    );
    const hasTable = lines.some(
      (i) =>
        i.kind === 'line' &&
        i.segments.some((s) => /[┌│]/.test(s.text))
    );
    expect(hasBold).toBe(true);
    expect(hasTable).toBe(true);
  });

  it('reuses paint cache for stable messages', () => {
    const cache = new MessagePaintCache();
    const message = msg({
      id: 1,
      from: 'agent',
      text: '## title\n\n' + 'hello '.repeat(20)
    });
    const a = cache.paintMessage(message, 60, false);
    const b = cache.paintMessage(message, 60, false);
    expect(b).toBe(a);
  });

  it('embeds tool cards as tool paint items', () => {
    const messages = [
      msg({
        id: 1,
        from: 'tool',
        text: '',
        tool: {
          name: 'Read',
          status: 'completed',
          risk: 'read',
          items: [{ path: 'a.ts', status: 'completed' }]
        }
      })
    ];
    const result = windowPaintRows({
      messages,
      columns: 80,
      viewportRows: 20,
      scrollOffset: 0
    });
    expect(result.items.some((i) => i.kind === 'tool')).toBe(true);
  });

  it('clips tall agent content by rows while keeping segment styles', () => {
    const table = [
      'intro',
      '',
      '| 排名 | 国家 |',
      '|------|------|',
      ...Array.from({ length: 20 }, (_, i) => `| ${i} | N${i} |`),
      '',
      'outro'
    ].join('\n');

    const messages = [
      msg({ id: 1, from: 'user', text: '表' }),
      msg({ id: 2, from: 'agent', text: table })
    ];

    const result = windowPaintRows({
      messages,
      columns: 80,
      viewportRows: 12,
      scrollOffset: 0
    });

    expect(result.hasMoreAbove).toBe(true);
    const plain = result.items.map(paintItemPlainText).join('\n');
    // 贴底应看到表后或表格区域，且有样式 segment
    const styled = result.items.some(
      (i) =>
        i.kind === 'line' &&
        i.segments.some((s) => s.bold || s.color || /[┌│]/.test(s.text))
    );
    expect(styled || plain.includes('outro') || plain.includes('│')).toBe(true);
  });
});

describe('parseMarkdownStreaming', () => {
  it('only re-parses the growing tail across deltas', () => {
    clearMarkdownParseCache();
    const key = 'stream-test-1';
    const p1 = parseMarkdownStreaming('# Title\n\npara one\n\n', key, true);
    expect(p1.some((l) => l.kind === 'heading')).toBe(true);

    const p2 = parseMarkdownStreaming(
      '# Title\n\npara one\n\n## Section\n\nmore text',
      key,
      true
    );
    expect(p2.some((l) => l.kind === 'heading' && l.level === 2)).toBe(true);

    // 完成态清理流状态
    const done = parseMarkdownStreaming(
      '# Title\n\npara one\n\n## Section\n\nmore text',
      key,
      false
    );
    expect(done.length).toBeGreaterThan(0);
  });
});
