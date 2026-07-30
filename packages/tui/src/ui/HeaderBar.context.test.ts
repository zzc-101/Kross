import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';

import { theme } from './theme';
import {
  HeaderBar,
  contextUsageTone,
  hitTestContextUsage,
  resolveHeaderHeight
} from './HeaderBar';

describe('contextUsageTone', () => {
  it('warns when usage reaches 80% of compact threshold', () => {
    expect(contextUsageTone(0.79)).toBe(theme.statusReady);
    expect(contextUsageTone(0.8)).toBe(theme.statusWarn);
    expect(contextUsageTone(0.95)).toBe(theme.statusWarn);
  });

  it('errors when usage meets or exceeds compact threshold', () => {
    expect(contextUsageTone(1)).toBe(theme.statusError);
    expect(contextUsageTone(1.2)).toBe(theme.statusError);
  });
});

describe('context usage details', () => {
  it('keeps LLM call metrics hidden until context usage is expanded', () => {
    const props = {
      projectName: 'local',
      queueLength: 0,
      compact: false,
      contextUsageLabel: '12K/256K',
      contextUsageRatio: 0.05,
      llmMetricsLabel: '13K tok · 1250ms · 2K cached · $0.0042'
    };
    const collapsed = render(React.createElement(HeaderBar, props));
    expect(collapsed.lastFrame()).toContain('12K/256K');
    expect(collapsed.lastFrame()).not.toContain('1250ms');
    expect(collapsed.lastFrame()).not.toContain('cached');

    const expanded = render(
      React.createElement(HeaderBar, {
        ...props,
        contextMetricsExpanded: true
      })
    );
    expect(expanded.lastFrame()).toContain(
      'LLM · 13K tok · 1250ms · 2K cached · $0.0042'
    );
  });

  it('hit-tests only the right-aligned context label', () => {
    expect(
      hitTestContextUsage({
        clickRow: 1,
        clickCol: 79,
        columns: 80,
        contextUsageLabel: '12K/256K'
      })
    ).toBe(true);
    expect(
      hitTestContextUsage({
        clickRow: 1,
        clickCol: 70,
        columns: 80,
        contextUsageLabel: '12K/256K'
      })
    ).toBe(false);
    expect(
      hitTestContextUsage({
        clickRow: 2,
        clickCol: 79,
        columns: 80,
        contextUsageLabel: '12K/256K'
      })
    ).toBe(false);
  });

  it('includes the expanded metrics row in header height', () => {
    expect(
      resolveHeaderHeight({
        compact: false,
        hasError: false,
        todoCount: 0,
        todoExpanded: false,
        contextMetricsExpanded: false
      })
    ).toBe(2);
    expect(
      resolveHeaderHeight({
        compact: false,
        hasError: false,
        todoCount: 0,
        todoExpanded: false,
        contextMetricsExpanded: true
      })
    ).toBe(3);
  });

  it('hides the entire right-side status area on the welcome screen', () => {
    const view = render(
      React.createElement(HeaderBar, {
        projectName: 'main  ~/project',
        queueLength: 2,
        compact: true,
        contextUsageLabel: '12K/256K',
        contextUsageRatio: 0.05,
        contextMetricsExpanded: true,
        llmMetricsLabel: '13K tok · 1250ms · 2K cached · $0.0042',
        todoSnapshot: {
          todos: [{ id: '1', content: '实现功能', status: 'in_progress' }],
          counts: {
            pending: 0,
            in_progress: 1,
            completed: 0,
            cancelled: 0
          }
        }
      })
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('main  ~/project');
    expect(frame).not.toContain('Todo');
    expect(frame).not.toContain('12K/256K');
    expect(frame).not.toContain('cached');
    expect(frame).not.toContain('队列');
  });
});
