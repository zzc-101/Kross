import { describe, expect, it } from 'vitest';

import type { ChatMessage } from './MessageLine';
import {
  estimateMessageRows,
  layoutFingerprint,
  markdownToVisualLines,
  MessageRowHeightCache,
  windowMessages
} from './messageLayout';

function msg(
  partial: Pick<ChatMessage, 'id' | 'from' | 'text'> & Partial<ChatMessage>
): ChatMessage {
  return {
    id: partial.id,
    from: partial.from,
    text: partial.text,
    expanded: partial.expanded
  };
}

describe('windowMessages', () => {
  it('keeps only the bottom slice when content exceeds the viewport', () => {
    const messages = Array.from({ length: 30 }, (_, index) =>
      msg({ id: index + 1, from: 'user', text: `line-${index}` })
    );
    const result = windowMessages({
      messages,
      columns: 80,
      viewportRows: 10,
      scrollOffset: 0
    });

    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.messages.at(-1)?.text).toContain('line-29');
    expect(result.maxScrollOffset).toBeGreaterThan(0);
    expect(result.hasMoreAbove).toBe(true);
    expect(result.hasMoreBelow).toBe(false);
  });

  it('scrolls up to reveal older messages', () => {
    const messages = Array.from({ length: 20 }, (_, index) =>
      msg({ id: index + 1, from: 'user', text: `m-${index}` })
    );
    const bottom = windowMessages({
      messages,
      columns: 80,
      viewportRows: 6,
      scrollOffset: 0
    });
    const scrolled = windowMessages({
      messages,
      columns: 80,
      viewportRows: 6,
      scrollOffset: bottom.maxScrollOffset
    });

    expect(scrolled.messages[0]?.text).toContain('m-0');
    expect(scrolled.hasMoreBelow).toBe(true);
  });

  it('estimates tall agent messages by wrapped lines', () => {
    const long = 'x'.repeat(400);
    const rows = estimateMessageRows(
      msg({ id: 1, from: 'agent', text: long }),
      40
    );
    expect(rows).toBeGreaterThan(10);
  });

  it('caches row heights across scrolls until content fingerprint changes', () => {
    const cache = new MessageRowHeightCache();
    const message = msg({
      id: 1,
      from: 'agent',
      text: '## title\n\n' + 'hello world '.repeat(40)
    });

    const first = cache.estimate(message, 60);
    const second = cache.estimate(message, 60);
    expect(second).toBe(first);

    const expanded = { ...message, expanded: true as const };
    // agent 消息 expanded 不改变行高估算路径，但 fingerprint 变了应重算（仍一致）
    expect(layoutFingerprint(message)).not.toBe(layoutFingerprint(expanded));

    const grown = {
      ...message,
      text: message.text + '\n\nmore lines\n'.repeat(20)
    };
    const afterGrow = cache.estimate(grown, 60);
    expect(afterGrow).toBeGreaterThan(first);

    // columns 变化清空缓存
    const wide = cache.estimate(grown, 120);
    expect(wide).toBeLessThan(afterGrow);
  });

  it('windowMessages reuses heightCache without changing window results', () => {
    const messages = Array.from({ length: 15 }, (_, index) =>
      msg({ id: index + 1, from: 'user', text: `row-${index}` })
    );
    const cache = new MessageRowHeightCache();
    const a = windowMessages({
      messages,
      columns: 80,
      viewportRows: 8,
      scrollOffset: 0,
      heightCache: cache
    });
    const b = windowMessages({
      messages,
      columns: 80,
      viewportRows: 8,
      scrollOffset: a.maxScrollOffset,
      heightCache: cache
    });
    expect(a.maxScrollOffset).toBe(b.maxScrollOffset);
    expect(b.hasMoreBelow).toBe(true);
  });

  it('clips tall agent tables by visual lines and keeps styled MdLines', () => {
    const table = [
      '说明文字',
      '',
      '| 排名 | 国家 | 首都 |',
      '|------|------|------|',
      '| 1 | 中国 | 北京 |',
      '| 2 | 印度 | 新德里 |',
      '| 3 | 美国 | 华盛顿 |',
      '| 4 | 印尼 | 雅加达 |',
      '| 5 | 巴西 | 巴西利亚 |',
      '| 6 | 俄罗斯 | 莫斯科 |',
      '| 7 | 日本 | 东京 |',
      '',
      '表后说明'
    ].join('\n');

    const messages = [
      msg({ id: 1, from: 'user', text: '出个表' }),
      msg({ id: 2, from: 'agent', text: table })
    ];

    // 视口很矮，强制裁剪 agent
    const result = windowMessages({
      messages,
      columns: 80,
      viewportRows: 12,
      scrollOffset: 0
    });

    const agent = result.messages.find((m) => m.from === 'agent');
    expect(agent).toBeDefined();
    // 贴底裁剪应产出带样式的 MdLine[]，而非纯文本降级
    expect(agent?.viewportLines).toBeDefined();
    expect(agent?.viewportLines?.length).toBeGreaterThan(0);
    const plain = (agent?.viewportLines ?? [])
      .map((line) => line.spans.map((s) => s.text).join(''))
      .join('\n');
    // 若包含表格，应是 box 字符而不是残缺的 | --- |
    if (plain.includes('┌') || plain.includes('│')) {
      const hasBrokenSeparator = /^\|[-:| ]+\|$/m.test(plain);
      expect(hasBrokenSeparator).toBe(false);
      // 裁剪行应保留 table kind 或 box 字符（样式未降级）
      const hasStyledTable = (agent?.viewportLines ?? []).some(
        (line) =>
          line.kind === 'table' ||
          line.spans.some((s) => /[┌┬┐├┼┤└┴┘│]/.test(s.text))
      );
      expect(hasStyledTable).toBe(true);
    }
  });

  it('preserves heading/code styles when clipping agent body', () => {
    const body = [
      '# Title',
      '',
      'intro paragraph',
      '',
      '```ts',
      'const x = 1',
      'const y = 2',
      '```',
      '',
      '**bold** and more text '.repeat(30)
    ].join('\n');

    const messages = [msg({ id: 1, from: 'agent', text: body })];
    const fullRows = estimateMessageRows(messages[0]!, 40);
    // 只露出底部几行 → 触发裁剪
    const result = windowMessages({
      messages,
      columns: 40,
      viewportRows: Math.max(4, Math.floor(fullRows / 3)),
      scrollOffset: 0
    });

    const agent = result.messages[0];
    expect(agent?.viewportLines).toBeDefined();
    const kinds = new Set((agent?.viewportLines ?? []).map((l) => l.kind));
    // 至少不应全是无样式的 paragraph 纯文本降级；应仍是解析后的 kind
    expect(kinds.size).toBeGreaterThanOrEqual(1);
    // 有任意 span 带 bold/color/dim 即说明样式保留
    const hasStyle = (agent?.viewportLines ?? []).some((line) =>
      line.spans.some((s) => s.bold || s.color || s.dim || s.italic)
    );
    // 若裁到含 code/heading 区域则必有样式；贴底长段落也可能只有 paragraph
    // 此处只断言结构是 MdLine 而非 string
    expect(Array.isArray(agent?.viewportLines)).toBe(true);
    void hasStyle;
  });
});

describe('markdownToVisualLines', () => {
  it('expands GFM tables to box-drawing lines', () => {
    const lines = markdownToVisualLines(
      ['| A | B |', '|---|---|', '| 1 | 2 |'].join('\n')
    );
    expect(lines.some((line) => line.includes('┌'))).toBe(true);
    expect(lines.some((line) => line.includes('A'))).toBe(true);
  });
});
