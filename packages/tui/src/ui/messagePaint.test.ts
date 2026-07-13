import { describe, expect, it } from 'vitest';

import type { ChatMessage } from './MessageLine';
import {
  buildPaintLayout,
  formatScrollHint,
  hitTestClickableMessage,
  hitTestThinkingMessageId,
  MessagePaintCache,
  paintItemPlainText,
  windowPaintLayout,
  windowPaintRows,
  wrapPaintSegments
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
    tool: partial.tool,
    durationMs: partial.durationMs,
    createdAt: partial.createdAt
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

  it('soft-wraps long agent lines so each paint row is height 1 with bullet', () => {
    const cache = new MessagePaintCache();
    const long =
      '这是一段很长的中文回复，用来验证终端列宽不足时会按显示宽度预折行，而不是交给 Ink 自动 wrap 导致续行错位。';
    const message = msg({ id: 1, from: 'agent', text: long });
    const items = cache.paintMessage(message, 40, false);
    const body = items.filter(
      (i) => i.kind === 'line' && i.key.startsWith('agent-1-L')
    );
    expect(body.length).toBeGreaterThan(1);
    let sawBullet = false;
    for (const row of body) {
      if (row.kind !== 'line') continue;
      expect(row.height).toBe(1);
      if (row.segments[0]?.text.includes('●')) {
        sawBullet = true;
      }
    }
    expect(sawBullet).toBe(true);
  });

  it('collapses thinking to a Thought summary line by default', () => {
    const cache = new MessagePaintCache();
    const message = msg({
      id: 2,
      from: 'thinking',
      text: 'long thought\nline2\nline3',
      durationMs: 8000
    });
    const items = cache.paintMessage(message, 80, false);
    const plains = items.map(paintItemPlainText).join('\n');
    expect(plains).toContain('Thought for 8s');
    expect(plains).not.toContain('long thought');
  });

  it('wrapPaintSegments keeps styles across soft wraps', () => {
    const lines = wrapPaintSegments(
      [
        { text: 'hello ', bold: true },
        { text: '世界world', color: 'cyan' }
      ],
      8
    );
    expect(lines.length).toBeGreaterThan(1);
    const flat = lines.flat();
    expect(flat.some((s) => s.bold && s.text.includes('hello'))).toBe(true);
    expect(flat.some((s) => s.color === 'cyan')).toBe(true);
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

  it('builds layout once and reuses it across scroll windows', () => {
    const cache = new CountingPaintCache();
    const messages = Array.from({ length: 40 }, (_, index) =>
      msg({ id: index + 1, from: 'user', text: `line-${index}` })
    );

    const layout = buildPaintLayout({
      messages,
      columns: 80,
      paintCache: cache
    });
    windowPaintLayout({ layout, viewportRows: 10, scrollOffset: 0 });
    windowPaintLayout({ layout, viewportRows: 10, scrollOffset: 12 });

    expect(cache.paintCalls).toBe(messages.length);
  });

  it('paints tools as plain lines with a single trailing gap', () => {
    const cache = new MessagePaintCache();
    const items = cache.paintMessage(
      msg({
        id: 1,
        from: 'tool',
        text: '',
        tool: {
          name: 'Edit',
          status: 'completed',
          linesAdded: 2,
          linesRemoved: 1,
          items: [{ path: 'test.txt', status: 'completed', linesAdded: 2, linesRemoved: 1 }]
        }
      }),
      80,
      false
    );
    expect(items.every((i) => i.kind === 'line' && i.height === 1)).toBe(true);
    expect(items).toHaveLength(2); // title + gap
    expect(paintItemPlainText(items[0]!)).toContain('Edit');
    expect(paintItemPlainText(items[0]!)).toContain('+2');
    expect(items[1]?.key).toContain('tool-gap');
  });

  it('paints expanded Edit diff with bg colors, context, and numeric line gutter', () => {
    const cache = new MessagePaintCache();
    const items = cache.paintMessage(
      msg({
        id: 9,
        from: 'tool',
        text: '',
        expanded: true,
        tool: {
          name: 'Edit',
          status: 'completed',
          linesAdded: 1,
          linesRemoved: 1,
          detailLines: [
            { text: 'Line 2: keep', op: 'ctx', lineNo: 2 },
            { text: 'Line 5: old', op: 'del', lineNo: 5 },
            { text: 'Line 5: new', op: 'add', lineNo: 5 },
            { text: 'tail', op: 'ctx', lineNo: 6 }
          ]
        }
      }),
      80,
      false
    );
    const plains = items.map(paintItemPlainText).join('\n');
    // 左侧行号是数字 5，不是 "Line 5"
    expect(plains).toMatch(/\b5\s+-\s+old/);
    expect(plains).toMatch(/\b5\s+\+\s+new/);
    expect(plains).not.toMatch(/Line 5/);
    const del = items.find((i) => paintItemPlainText(i).includes('- old'));
    expect(
      del &&
        del.kind === 'line' &&
        del.segments.some((s) => s.backgroundColor === '#7f1d1d')
    ).toBe(true);
  });

  it('hit-tests tool title rows for expand', () => {
    const messages = [
      msg({
        id: 5,
        from: 'tool',
        text: '',
        tool: {
          name: 'Read',
          status: 'completed',
          summary: 'read 3 lines',
          detailLines: [{ text: 'read 3 lines', op: 'meta' }]
        }
      })
    ];
    const contentRows = 20;
    const windowed = windowPaintRows({
      messages,
      columns: 80,
      viewportRows: contentRows,
      scrollOffset: 0
    });
    const height = windowed.items.reduce((s, i) => s + i.height, 0);
    const viewportTopRow = 2;
    const padTop = contentRows - height;
    let local = 0;
    let titleLocal: number | undefined;
    for (const item of windowed.items) {
      if (item.key.startsWith('tool-5-title')) {
        titleLocal = local;
        break;
      }
      local += item.height;
    }
    expect(titleLocal).toBeDefined();
    const hit = hitTestClickableMessage({
      messages,
      columns: 80,
      contentRows,
      scrollOffset: 0,
      clickRow: viewportTopRow + padTop + (titleLocal ?? 0),
      viewportTopRow
    });
    expect(hit).toEqual({ kind: 'tool', messageId: 5 });
  });

  it('keeps windowed row count within viewport (no flex-end overfill)', () => {
    const messages = Array.from({ length: 40 }, (_, index) => {
      if (index % 3 === 0) {
        return msg({
          id: index + 1,
          from: 'tool',
          text: '',
          tool: {
            name: 'Read',
            status: 'completed',
            items: [{ path: `f-${index}.ts`, status: 'completed' }]
          }
        });
      }
      return msg({ id: index + 1, from: 'agent', text: `line-${index}` });
    });
    const result = windowPaintRows({
      messages,
      columns: 80,
      viewportRows: 12,
      scrollOffset: 0
    });
    const used = result.items.reduce((sum, item) => sum + item.height, 0);
    expect(used).toBeLessThanOrEqual(12);
    expect(used).toBeGreaterThan(0);
  });

  it('formats compact scroll hints', () => {
    expect(formatScrollHint(true, false)).toBe('↑ 历史');
    expect(formatScrollHint(false, true)).toBe('↓ 回底部');
    expect(formatScrollHint(true, true)).toContain('↑');
    expect(formatScrollHint(false, false)).toBeNull();
  });

  it('hit-tests thinking only on Thought paint rows', () => {
    const messages = [
      msg({ id: 1, from: 'user', text: 'hi' }),
      msg({
        id: 2,
        from: 'thinking',
        text: 'secret thought',
        durationMs: 1000
      }),
      msg({ id: 3, from: 'agent', text: 'answer' })
    ];
    // 构造：viewport 足够大，内容贴底
    const viewportRows = 20;
    const contentRows = 20;
    const layoutHeight = (() => {
      const w = windowPaintRows({
        messages,
        columns: 80,
        viewportRows: contentRows,
        scrollOffset: 0
      });
      return w.items.reduce((s, i) => s + i.height, 0);
    })();
    const viewportTopRow = 3;
    const padTop = contentRows - layoutHeight;
    // Thought 摘要是 thinking 消息的首行（在 agent 之前）
    // 从 window 取 thinking 行的相对位置
    const windowed = windowPaintRows({
      messages,
      columns: 80,
      viewportRows: contentRows,
      scrollOffset: 0
    });
    let offset = 0;
    let thoughtLocal: number | undefined;
    for (const item of windowed.items) {
      if (item.key.startsWith('th-h-2')) {
        thoughtLocal = offset;
        break;
      }
      offset += item.height;
    }
    expect(thoughtLocal).toBeDefined();
    const thoughtRow = viewportTopRow + padTop + (thoughtLocal ?? 0);

    expect(
      hitTestThinkingMessageId({
        messages,
        columns: 80,
        contentRows,
        scrollOffset: 0,
        clickRow: thoughtRow,
        viewportTopRow
      })
    ).toBe(2);

    // 点 agent 行不应命中
    let agentLocal: number | undefined;
    offset = 0;
    for (const item of windowed.items) {
      if (item.key.startsWith('agent-3')) {
        agentLocal = offset;
        break;
      }
      offset += item.height;
    }
    expect(agentLocal).toBeDefined();
    const agentRow = viewportTopRow + padTop + (agentLocal ?? 0);
    expect(
      hitTestThinkingMessageId({
        messages,
        columns: 80,
        contentRows,
        scrollOffset: 0,
        clickRow: agentRow,
        viewportTopRow
      })
    ).toBeUndefined();

    // 点视口上方空白（flex-end pad）
    if (padTop > 0) {
      expect(
        hitTestThinkingMessageId({
          messages,
          columns: 80,
          contentRows,
          scrollOffset: 0,
          clickRow: viewportTopRow,
          viewportTopRow
        })
      ).toBeUndefined();
    }
    void viewportRows;
  });

  it('does not stack trailing agent blanks with message gap before tools', () => {
    const cache = new MessagePaintCache();
    const tight = cache.paintMessage(
      msg({ id: 1, from: 'agent', text: '准备修改文件。' }),
      80,
      false
    );
    const trailing = cache.paintMessage(
      msg({
        id: 2,
        from: 'agent',
        text: '准备修改文件。\n\n\n'
      }),
      80,
      false
    );
    // 文末 \\n\\n 产生的 blank 应被裁掉，只保留一条 gap
    expect(trailing.filter((i) => i.kind === 'line').length).toBe(
      tight.filter((i) => i.kind === 'line').length
    );
    expect(trailing.at(-1)?.key).toContain('agent-gap');
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

class CountingPaintCache extends MessagePaintCache {
  paintCalls = 0;

  override paintMessage(
    ...args: Parameters<MessagePaintCache['paintMessage']>
  ): ReturnType<MessagePaintCache['paintMessage']> {
    this.paintCalls += 1;
    return super.paintMessage(...args);
  }
}

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
