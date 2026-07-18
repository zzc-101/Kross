import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { ThinkingIndicator } from './ThinkingIndicator';

describe('ThinkingIndicator', () => {
  it('renders a distinct Kross activity line', async () => {
    const view = render(<ThinkingIndicator active />);

    try {
      await waitUntil(() => view.lastFrame()?.includes('读取工作区') === true);
      expect(view.lastFrame()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 读取工作区… \(0 秒\)/);
      expect(view.lastFrame()).not.toContain('思考中');
      expect(view.lastFrame()).not.toContain('Thinking');

      await new Promise((resolve) => setTimeout(resolve, 1_300));
      expect(view.lastFrame()).toMatch(/读取工作区… \([1-9]\d* 秒\)/);
    } finally {
      view.unmount();
    }
  });

  it('uses tool activity phrases without pretending they are model thinking', async () => {
    const view = render(<ThinkingIndicator active variant="tool" />);

    try {
      await waitUntil(
        () => view.lastFrame()?.includes('运行已允许的工具') === true
      );
      expect(view.lastFrame()).toContain('运行已允许的工具…');
      expect(view.lastFrame()).not.toContain('思考中');
    } finally {
      view.unmount();
    }
  });

  it('shows the real run phase without rotating generic activity copy', async () => {
    const view = render(<ThinkingIndicator active phase="verify" />);

    try {
      await waitUntil(() => view.lastFrame()?.includes('正在验证') === true);
      const first = view.lastFrame();
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(view.lastFrame()).toContain('正在验证…');
      expect(view.lastFrame()).not.toContain('读取工作区');
      expect(first).toContain('正在验证…');
    } finally {
      view.unmount();
    }
  });

  it('shows a stable interrupting state without the Esc hint', async () => {
    const view = render(<ThinkingIndicator active variant="cancelling" />);

    try {
      await waitUntil(() => view.lastFrame()?.includes('正在中断') === true);
      expect(view.lastFrame()).toContain('正在中断…');
      expect(view.lastFrame()).not.toContain('Esc 中断');
    } finally {
      view.unmount();
    }
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitUntil timed out');
}
