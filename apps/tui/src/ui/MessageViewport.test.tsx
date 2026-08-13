import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';

import { MessageViewport } from './MessageViewport';

describe('MessageViewport', () => {
  it('updates streaming thinking seconds even when no new delta arrives', async () => {
    const view = render(
      <MessageViewport
        messages={[
          {
            id: 1,
            from: 'thinking',
            text: '正在推理',
            createdAt: new Date().toISOString()
          }
        ]}
        streamingMessageId={1}
        height={4}
        columns={80}
      />
    );

    try {
      expect(view.lastFrame()).toContain('思考中… 0 秒');
      await new Promise((resolve) => setTimeout(resolve, 1_350));
      expect(view.lastFrame()).toMatch(/思考中… [1-9]\d* 秒/);
    } finally {
      view.unmount();
    }
  });
});
