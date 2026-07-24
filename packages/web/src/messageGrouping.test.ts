import { describe, expect, it } from 'vitest';

import { groupMessagesForDisplay } from './messageGrouping';
import type { UiMessage } from './useCloud';

function message(
  id: string,
  from: UiMessage['from'],
  text: string
): UiMessage {
  return { id, from, text };
}

describe('groupMessagesForDisplay', () => {
  it('attaches thinking to the following assistant content', () => {
    const result = groupMessagesForDisplay([
      message('thinking', 'thinking', '先检查目录'),
      message('tool', 'tool', 'List')
    ]);

    expect(result).toEqual([
      {
        message: message('tool', 'tool', 'List'),
        thinking: '先检查目录'
      }
    ]);
  });

  it('keeps trailing thinking visible while a response is streaming', () => {
    const thinking = message('thinking', 'thinking', '仍在分析');
    expect(groupMessagesForDisplay([thinking])).toEqual([{ message: thinking }]);
  });

  it('does not attach stale thinking to a later user message', () => {
    const thinking = message('thinking', 'thinking', '上轮思考');
    const user = message('user', 'user', '新问题');
    expect(groupMessagesForDisplay([thinking, user])).toEqual([
      { message: thinking },
      { message: user }
    ]);
  });
});
