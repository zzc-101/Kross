import { describe, expect, it } from 'vitest';

import type { SubagentUiState } from '../app/subagentUi';
import {
  formatCollapsedLine,
  hitTestSubagentPanel,
  resolveSubagentPanelHeight
} from './SubagentPanel';

const sample: SubagentUiState = {
  subRunId: 'sub-parent-abc123',
  parentRunId: 'parent',
  mode: 'explore',
  status: 'running',
  promptPreview: 'scan modules',
  currentTool: 'Read',
  toolCount: 2,
  updatedAt: Date.now()
};

describe('SubagentPanel layout', () => {
  it('always uses one row when any subagent is present', () => {
    expect(resolveSubagentPanelHeight([sample], false)).toBe(1);
    expect(resolveSubagentPanelHeight([sample, sample], true)).toBe(1);
    expect(resolveSubagentPanelHeight([], false)).toBe(0);
  });

  it('formats a single status line with short title only', () => {
    const line = formatCollapsedLine(
      { ...sample, title: 'Append to test.txt' },
      1,
      '⠋',
      60
    );
    expect(line).toContain('Subagent · Append to test.txt');
    expect(line).toContain('running');
    expect(line).not.toContain('scan modules');
    expect(line).not.toContain('Read');
  });

  it('formats cancelled state as interrupted', () => {
    const line = formatCollapsedLine(
      {
        ...sample,
        title: 'Edit file',
        status: 'cancelled',
        currentTool: undefined,
        summaryPreview: 'interrupted'
      },
      1,
      '⠋',
      60
    );
    expect(line).toContain('interrupted');
    expect(line).toContain('Edit file');
    expect(line).not.toContain('running');
  });

  it('hits the strip under the viewport', () => {
    // contentTop(1) + header(2) + viewport(10) = panel starts at row 13
    expect(
      hitTestSubagentPanel({
        clickRow: 13,
        headerHeight: 2,
        viewportHeight: 10,
        panelHeight: 1,
        hasSubagents: true,
        contentTopRow: 1
      })
    ).toBe(true);
    expect(
      hitTestSubagentPanel({
        clickRow: 12,
        headerHeight: 2,
        viewportHeight: 10,
        panelHeight: 1,
        hasSubagents: true,
        contentTopRow: 1
      })
    ).toBe(false);
  });
});
