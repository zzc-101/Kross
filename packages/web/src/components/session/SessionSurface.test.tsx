import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { compactToolSummary, Message, ToolCard } from './SessionSurface';

describe('SessionSurface simplified chat chrome', () => {
  it('does not render role labels around chat messages', () => {
    const user = renderToStaticMarkup(
      <Message message={{ id: 'u1', from: 'user', text: '开始探索' }} />
    );
    const agent = renderToStaticMarkup(
      <Message message={{ id: 'a1', from: 'agent', text: '探索完成' }} />
    );
    const thinking = renderToStaticMarkup(
      <Message message={{ id: 't1', from: 'thinking', text: '分析中' }} />
    );

    expect(user).not.toContain('message-author');
    expect(agent).not.toContain('message-author');
    expect(thinking).not.toContain('message-author');
  });

  it('keeps the tool name and status without the redundant tool badge', () => {
    const html = renderToStaticMarkup(
      <ToolCard
        type="tool_call.completed"
        payload={{ toolName: 'Task', summary: '探索完成' }}
      />
    );

    expect(html).toContain('Task');
    expect(html.match(/class="inline-flex/g) ?? []).toHaveLength(1);
  });

  it('removes the duplicated tool name and completion prefix from summaries', () => {
    expect(
      compactToolSummary(
        'Task',
        'Task (项目简单探索) → completed: 项目探索摘要'
      )
    ).toBe('(项目简单探索) → 项目探索摘要');
    expect(compactToolSummary('Read', 'Read read 5 lines')).toBe('read 5 lines');
  });

  it('renders attached thinking inside the following tool message', () => {
    const html = renderToStaticMarkup(
      <Message
        message={{
          id: 'tool',
          from: 'tool',
          text: '完成',
          liveTool: {
            type: 'tool_call.completed',
            payload: { toolName: 'Read', summary: 'Read read 5 lines' }
          }
        }}
        thinking="先读取文件"
      />
    );

    expect(html).toContain('session.viewThinking');
    expect(html).toContain('tool-disclosure');
    expect(html).toContain('read 5 lines');
  });
});
