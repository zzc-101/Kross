import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { initI18n } from '@kross/core';

import * as approvalPanelModule from './ApprovalPanel';
import { ApprovalPanel } from './ApprovalPanel';
import { displayWidth } from './markdownParse';
import { ModelSettingsPanel } from './ModelSettingsPanel';
import { ToolCallCard } from './ToolCallCard';
import { WelcomeHome } from './WelcomeHome';

describe('panel borders', () => {
  afterEach(() => initI18n('zh'));

  it('aligns the approval panel right border on every framed row', () => {
    const { lastFrame } = render(
      <ApprovalPanel
        approval={{
          runId: 'run-1',
          toolCallId: 'call-1',
          toolName: 'fs.write',
          risk: 'write',
          reason: 'write tool requires approval',
          inputPreview: '{"path":"README.md"}'
        }}
        selection="approve"
      />
    );

    expect(borderWidths(lastFrame())).toEqual([72, 72, 72, 72, 72, 72, 72]);
    expect(lastFrame()).toContain('允许修改工作区？');
    expect(lastFrame()).toContain('工具  fs.write');
    expect(lastFrame()).toContain('风险  文件写入');
    expect(lastFrame()).toContain('允许一次');
    expect(lastFrame()).toContain('拒绝');
    expect(lastFrame()).toContain('该操作需要你的确认');
    expect(lastFrame()).not.toContain('tool  ');
    expect(lastFrame()).not.toContain('Approve');
    expect(lastFrame()).not.toContain('requires approval');
  });

  it('defaults execute and network approvals to reject', () => {
    const defaultSelection = (approvalPanelModule as any)
      .defaultApprovalSelection;
    expect(defaultSelection).toBeTypeOf('function');
    if (typeof defaultSelection !== 'function') {
      return;
    }

    expect(defaultSelection('read')).toBe('approve');
    expect(defaultSelection('write')).toBe('approve');
    expect(defaultSelection('execute')).toBe('reject');
    expect(defaultSelection('network')).toBe('reject');
  });

  it('localizes approval labels in English mode', () => {
    initI18n('en');
    const { lastFrame } = render(
      <ApprovalPanel
        approval={{
          runId: 'run-en',
          toolCallId: 'call-en',
          toolName: 'Bash',
          risk: 'execute',
          reason: 'command execution requires approval',
          inputPreview: 'npm test'
        }}
        selection="reject"
      />
    );

    expect(lastFrame()).toContain('Tool  Bash');
    expect(lastFrame()).toContain('Risk  Command execution');
    expect(lastFrame()).toContain('Allow once');
    expect(lastFrame()).toContain('Reject');
    expect(lastFrame()).not.toContain('工具');
  });

  it('shows a check mark when a tool call completes', () => {
    const { lastFrame } = render(
      <ToolCallCard
        tool={{
          name: 'Read',
          status: 'completed',
          items: [{ path: 'README.md', status: 'completed' }]
        }}
      />
    );

    expect(lastFrame()).toContain('✓');
  });

  it.each([60, 80, 120])(
    'fits approval panels within a %i-column content area',
    (availableWidth) => {
      const expectedWidth = Math.min(availableWidth, 72);
      const { lastFrame } = render(
        React.createElement(ApprovalPanel as any, {
          approval: {
            runId: 'run-1',
            toolCallId: 'call-1',
            toolName: 'Bash',
            risk: 'execute',
            reason: 'execute tool requires approval',
            inputPreview: 'npm test -- --run'
          },
          selection: 'reject',
          width: availableWidth
        })
      );

      expect(new Set(borderWidths(lastFrame()))).toEqual(
        new Set([expectedWidth])
      );
    }
  );

  it('reports the exact approval panel height', () => {
    const resolveHeight = (approvalPanelModule as any)
      .resolveApprovalPanelHeight;
    expect(resolveHeight).toBeTypeOf('function');
    if (typeof resolveHeight !== 'function') {
      return;
    }

    expect(
      resolveHeight({
        runId: 'run-1',
        toolCallId: 'call-1',
        toolName: 'Bash',
        risk: 'execute',
        reason: 'execute tool requires approval',
        inputPreview: 'npm test'
      })
    ).toBe(10);
  });

  it('aligns continuation lines with the first Chinese-labeled preview line', () => {
    const { lastFrame } = render(
      <ApprovalPanel
        approval={{
          runId: 'run-1',
          toolCallId: 'call-1',
          toolName: 'Bash',
          risk: 'execute',
          inputPreview: 'alpha\nbeta'
        }}
        selection="reject"
        width={60}
      />
    );
    const lines = (lastFrame() ?? '').split('\n');
    const alphaLine = lines.find((line) => line.includes('alpha')) ?? '';
    const betaLine = lines.find((line) => line.includes('beta')) ?? '';

    expect(displayWidth(alphaLine.slice(0, alphaLine.indexOf('alpha')))).toBe(
      displayWidth(betaLine.slice(0, betaLine.indexOf('beta')))
    );
  });

  it.each([60, 80, 120])(
    'keeps the welcome card inside a %i-column content area',
    (availableWidth) => {
      const expectedWidth = Math.min(availableWidth, 88);
      const { lastFrame } = render(
        <WelcomeHome width={availableWidth} />
      );

      const widths = borderWidths(lastFrame());
      if (availableWidth <= 100) {
        expect(new Set(widths)).toEqual(new Set([expectedWidth]));
      } else {
        // ink-testing-library 固定为 100 列，会裁掉 120 列画布中的居中内容行；
        // 顶/底边框仍可验证卡片的 88 列上限。
        expect(Math.max(...widths)).toBe(expectedWidth);
      }
      expect(lastFrame()).toContain('__ __   ____');
      expect(lastFrame()).toContain('v0.1.0');
      expect(lastFrame()).not.toContain('╱──K─╲');
    }
  );

  it('falls back to the compact KROSS brand when the wordmark does not fit', () => {
    const { lastFrame } = render(<WelcomeHome width={40} />);

    expect(lastFrame()).toContain('KROSS');
    expect(lastFrame()).toContain('v0.1.0');
    expect(lastFrame()).not.toContain('/ //_/');
    expect(lastFrame()).not.toContain('╱──K─╲');
    expect(new Set(borderWidths(lastFrame()))).toEqual(new Set([40]));
  });

  it('aligns the model settings right border on every framed row', () => {
    const { lastFrame } = render(
      <ModelSettingsPanel
        width={72}
        state={{
          section: 'effort',
          effortIndex: 0,
          modelIndex: 0,
          efforts: [{ id: 'high', label: 'high' }],
          models: []
        }}
      />
    );

    expect(borderWidths(lastFrame())).toEqual([72, 72, 72, 72, 72, 72]);
  });
});

function borderWidths(frame: string | undefined): number[] {
  return (frame ?? '')
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => /^[╭│╰]/.test(line))
    .map(displayWidth);
}
