import React from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('moves a double-width character to the next line instead of overflowing', () => {
    // ink-testing-library 的 stdout 为 100 列；Markdown 预留 4 列，bullet
    // 再占 2 列，因此正文宽 94。首个 span 占 93，粗体中文必须换行。
    const source = `${'a'.repeat(93)}**你**`;
    const { lastFrame } = render(
      <Box width={96} flexDirection="column">
        <Markdown source={source} bullet="●" />
      </Box>
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('你');
    expect(frame).not.toContain('…');
    expect(frame.split('\n')).toHaveLength(2);
  });
});
