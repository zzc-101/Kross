import { describe, expect, it } from 'vitest';

import { hydrateSnapshotMessages } from './useCloud';

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
