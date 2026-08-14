import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../api/types';
import { reconcileMessageSnapshot } from './AgentRuntimeProvider';

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'assistant-1',
    conversationId: 'conversation-1',
    role: 'agent',
    content: '',
    parts: [],
    status: 'processing',
    createdAt: '2026-08-14T00:00:00.000Z',
    ...overrides
  };
}

describe('reconcileMessageSnapshot', () => {
  it('处理中数据库空快照不会清除已收到的流式内容', () => {
    const streamed = message({
      content: '已经输出的内容',
      parts: [{ type: 'text', text: '已经输出的内容' }]
    });

    expect(reconcileMessageSnapshot([streamed], [message()])).toEqual([streamed]);
  });

  it('完成快照始终替换临时流式内容', () => {
    const streamed = message({ content: '部分', parts: [{ type: 'text', text: '部分' }] });
    const completed = message({
      content: '完整内容',
      parts: [{ type: 'text', text: '完整内容' }],
      status: 'done'
    });

    expect(reconcileMessageSnapshot([streamed], [completed])).toEqual([completed]);
  });
});
