import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { ApprovalPanel } from './ApprovalPanel';
import { displayWidth } from './markdownParse';
import { ModelSettingsPanel } from './ModelSettingsPanel';

describe('panel borders', () => {
  it('aligns the approval panel right border on every framed row', () => {
    const { lastFrame } = render(
      <ApprovalPanel
        approval={{
          runId: 'run-1',
          toolCallId: 'call-1',
          toolName: 'fs.write',
          risk: 'write',
          reason: '需要写入文件',
          inputPreview: '{"path":"README.md"}'
        }}
        selection="approve"
      />
    );

    expect(borderWidths(lastFrame())).toEqual([72, 72, 72, 72, 72, 72, 72]);
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
    .filter((line) => /^[╭│╰]/.test(line))
    .map(displayWidth);
}
