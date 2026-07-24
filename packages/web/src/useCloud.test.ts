import { describe, expect, it } from 'vitest';

import {
  hydrateSnapshotMessages,
  reconcileSnapshotMessages,
  replaceSessionSummary,
  upsertLiveToolMessage
} from './useCloud';

describe('hydrateSnapshotMessages', () => {
  it('保留 snapshot 中的历史工具卡片与验证摘要', () => {
    const messages = hydrateSnapshotMessages([
      {
        id: 7,
        from: 'tool',
        text: '修改了 1 个文件',
        tool: {
          callId: 'call-1',
          name: 'apply_patch',
          risk: 'medium',
          status: 'completed',
          summary: '更新配置',
          inputPreview: '*** Begin Patch',
          durationMs: 42,
          linesAdded: 3,
          linesRemoved: 1,
          detailLines: [
            { text: '+enabled=true', op: 'add', lineNo: 12 }
          ],
          items: [
            {
              path: 'config.ts',
              status: 'completed',
              summary: '已更新'
            }
          ]
        },
        verification: {
          status: 'passed',
          commands: ['npm test'],
          evidence: ['测试通过']
        }
      }
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        id: '7',
        from: 'tool',
        text: '修改了 1 个文件',
        tool: expect.objectContaining({
          name: 'apply_patch',
          status: 'completed',
          detailLines: [
            { text: '+enabled=true', op: 'add', lineNo: 12 }
          ]
        }),
        verification: {
          status: 'passed',
          commands: ['npm test'],
          evidence: ['测试通过']
        }
      })
    ]);
  });

  it('不为普通消息增加空的工具字段', () => {
    expect(
      hydrateSnapshotMessages([{ id: 1, from: 'agent', text: '完成' }])
    ).toEqual([{ id: '1', from: 'agent', text: '完成' }]);
  });
});

describe('reconcileSnapshotMessages', () => {
  it('authoritative snapshot replaces transient agent and thinking messages', () => {
    expect(
      reconcileSnapshotMessages(
        [
          {
            id: 'stream-agent',
            from: 'agent',
            text: '先读取仓库。最终答案',
            transient: true,
            streaming: false
          },
          {
            id: 'stream-thinking',
            from: 'thinking',
            text: '分析中',
            transient: true,
            streaming: false
          }
        ],
        [
          { id: 1, from: 'agent', text: '先读取仓库。' },
          { id: 2, from: 'agent', text: '最终答案' }
        ]
      )
    ).toEqual([
      { id: '1', from: 'agent', text: '先读取仓库。' },
      { id: '2', from: 'agent', text: '最终答案' }
    ]);
  });

  it('keeps only an optimistic user message that is not persisted yet', () => {
    expect(
      reconcileSnapshotMessages(
        [
          {
            id: 'optimistic-user',
            from: 'user',
            text: '检查项目',
            transient: true
          }
        ],
        []
      )
    ).toEqual([
      {
        id: 'optimistic-user',
        from: 'user',
        text: '检查项目',
        transient: true
      }
    ]);
  });
});

describe('replaceSessionSummary', () => {
  const summary = (id: string, title: string) => ({
    id,
    title,
    preview: '',
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
    messageCount: 0
  });

  it('updates a selected session in place without moving it to the top', () => {
    const sessions = [
      summary('session-a', 'A'),
      summary('session-b', 'B'),
      summary('session-c', 'C')
    ];

    expect(
      replaceSessionSummary(sessions, summary('session-b', 'B updated'))
    ).toEqual([
      summary('session-a', 'A'),
      summary('session-b', 'B updated'),
      summary('session-c', 'C')
    ]);
  });

  it('prepends a newly created session that is not in the current list', () => {
    expect(
      replaceSessionSummary(
        [summary('session-a', 'A')],
        summary('session-new', 'New')
      ).map((session) => session.id)
    ).toEqual(['session-new', 'session-a']);
  });
});

describe('upsertLiveToolMessage', () => {
  it('keeps a live tool call at its original message position while updating it', () => {
    const beforeTool = {
      id: 'agent-before',
      from: 'agent' as const,
      text: '我先查看目录。'
    };
    const started = upsertLiveToolMessage([beforeTool], {
      id: 'trace-start',
      runId: 'run-1',
      type: 'tool_call.started',
      timestamp: '2026-07-24T00:00:00.000Z',
      payload: {
        callId: 'call-1',
        toolName: 'List',
        input: { path: '.' }
      }
    });
    const afterTool = [
      ...started,
      {
        id: 'agent-after',
        from: 'agent' as const,
        text: '目录内容如下。'
      }
    ];
    const completed = upsertLiveToolMessage(afterTool, {
      id: 'trace-complete',
      runId: 'run-1',
      type: 'tool_call.completed',
      timestamp: '2026-07-24T00:00:01.000Z',
      payload: {
        callId: 'call-1',
        toolName: 'List',
        summary: 'listed 6 entries',
        durationMs: 16
      }
    });

    expect(completed.map((message) => message.id)).toEqual([
      'agent-before',
      'live-tool:call-1',
      'agent-after'
    ]);
    expect(completed[1]?.liveTool).toEqual({
      type: 'tool_call.completed',
      payload: {
        callId: 'call-1',
        toolName: 'List',
        input: { path: '.' },
        summary: 'listed 6 entries',
        durationMs: 16
      }
    });
  });

  it('does not insert subagent tools into the main transcript', () => {
    expect(
      upsertLiveToolMessage([], {
        id: 'trace-sub',
        runId: 'sub-run-1',
        type: 'tool_call.started',
        timestamp: '2026-07-24T00:00:00.000Z',
        payload: { callId: 'call-sub', toolName: 'Read' }
      })
    ).toEqual([]);
  });
});
