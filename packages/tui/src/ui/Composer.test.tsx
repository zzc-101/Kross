import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import {
  COMPOSER_BOTTOM_GAP,
  COMPOSER_FEEDBACK_HEIGHT,
  COMPOSER_FOOTER_HEIGHT,
  COMPOSER_FRAME_HEIGHT,
  COMPOSER_HEIGHT,
  Composer,
  shouldIgnoreComposerInput
} from './Composer';
import { displayWidth } from './markdownParse';

describe('Composer', () => {
  it('ignores global control shortcuts instead of inserting their letters', () => {
    expect(shouldIgnoreComposerInput({ ctrl: true })).toBe(true);
    expect(shouldIgnoreComposerInput({ meta: true })).toBe(true);
    expect(shouldIgnoreComposerInput({})).toBe(false);
  });

  it('reserves a feedback row and three footer rows below the input frame', () => {
    expect(COMPOSER_FEEDBACK_HEIGHT).toBe(1);
    expect(COMPOSER_FRAME_HEIGHT).toBe(3);
    expect(COMPOSER_BOTTOM_GAP).toBe(3);
    expect(COMPOSER_FOOTER_HEIGHT).toBe(
      COMPOSER_HEIGHT + COMPOSER_BOTTOM_GAP
    );
  });

  it('renders a single-row input with metadata embedded in the bottom border', () => {
    const { lastFrame } = render(
      <Composer
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        modelLabel="Grok 4.5 (high)"
        permissionMode="auto"
        width={64}
      />
    );

    const lines = lastFrame()?.split('\n') ?? [];
    expect(lines).toHaveLength(COMPOSER_FOOTER_HEIGHT);
    expect(lines[0]).toBe('');
    expect(lines[1]).toMatch(/^╭─+╮$/);
    expect(lines[2]).toMatch(/^│\s+❯/);
    expect(lines[2]).toContain('描述任务，输入 / 查看命令');
    expect(lines[2]).toMatch(/│$/);
    expect(lines[3]).toMatch(
      /^╰─+ Grok 4\.5 \(high\) · 模式：自动 · 权限：自动允许 ─╯$/
    );
    expect(lines.slice(COMPOSER_HEIGHT)).toEqual(['', '', '']);
  });

  it('shows copy feedback above the right side of the input frame', () => {
    const { lastFrame } = render(
      <Composer
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        width={64}
        bottomGap={0}
        clipboardFeedback="copied"
      />
    );

    const lines = lastFrame()?.split('\n') ?? [];
    expect(lines).toHaveLength(COMPOSER_HEIGHT);
    expect(lines[0]?.trim()).toBe('Copied');
    expect(lines[0]).toMatch(/^\s+Copied$/);
    expect(lines[1]).toMatch(/^╭─+╮$/);
  });

  it.each([60, 80, 120])(
    'keeps all visible frame rows at %i display columns',
    (width) => {
      const { lastFrame } = render(
        <Composer
          value=""
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          modelLabel="Grok 4.5 (high)"
          permissionMode="auto"
          width={width}
        />
      );

      const rows = (lastFrame() ?? '')
        .split('\n')
        .slice(COMPOSER_FEEDBACK_HEIGHT, COMPOSER_HEIGHT);
      expect([rows[0]!, rows[2]!].map(displayWidth)).toEqual([width, width]);
      if (width <= 100) {
        expect(displayWidth(rows[1]!)).toBe(width);
      }
    }
  );
});
