import { describe, expect, it } from 'vitest';
import { initI18n, type TodoStoreSnapshot } from '@kross/core';

import {
  formatTodoHeaderLabel,
  formatTodoHeaderLines,
  hitTestTodoToggle,
  resolveHeaderHeight,
  TODO_STATUS_MARK
} from './HeaderBar';

describe('HeaderBar todo formatting', () => {
  it('formats empty and expandable progress labels', () => {
    initI18n('zh');
    expect(formatTodoHeaderLabel(undefined)).toBe('Todo · —');
    expect(
      formatTodoHeaderLabel(
        {
          todos: [
            { id: '1', content: 'A', status: 'completed' },
            { id: '2', content: 'B', status: 'pending' }
          ],
          counts: {
            pending: 1,
            in_progress: 0,
            completed: 1,
            cancelled: 0
          }
        },
        false
      )
    ).toBe('Todo 1/2 ▸');
    expect(
      formatTodoHeaderLabel(
        {
          todos: [{ id: '1', content: 'A', status: 'completed' }],
          counts: {
            pending: 0,
            in_progress: 0,
            completed: 1,
            cancelled: 0
          }
        },
        true
      )
    ).toBe('Todo 1/1 ▾');
  });

  it('keeps store order and uses checkmark for completed items', () => {
    initI18n('zh');
    expect(TODO_STATUS_MARK.completed).toBe('✓');
    const snapshot: TodoStoreSnapshot = {
      todos: [
        { id: '1', content: 'step one done', status: 'completed' },
        { id: '2', content: 'active task now', status: 'in_progress' },
        { id: '3', content: 'pending task', status: 'pending' }
      ],
      counts: {
        pending: 1,
        in_progress: 1,
        completed: 1,
        cancelled: 0
      }
    };
    const lines = formatTodoHeaderLines(snapshot, 40);
    // Stable order: completed stays first if written first (no status re-sort).
    expect(lines[0]?.text).toContain('✓ step one done');
    expect(lines[1]?.text).toContain('◻ active task now');
    expect(lines[2]?.text).toContain('☐ pending task');
  });

  it('resolves header height and click hit region for expand toggle', () => {
    expect(
      resolveHeaderHeight({
        compact: false,
        hasError: false,
        todoCount: 3,
        todoExpanded: false
      })
    ).toBe(2);
    expect(
      resolveHeaderHeight({
        compact: false,
        hasError: false,
        todoCount: 3,
        todoExpanded: true
      })
    ).toBe(5);

    expect(
      hitTestTodoToggle({
        clickRow: 1,
        clickCol: 60,
        columns: 80,
        compact: false,
        hasError: false,
        todoCount: 2,
        todoExpanded: false
      })
    ).toBe(true);
    expect(
      hitTestTodoToggle({
        clickRow: 1,
        clickCol: 5,
        columns: 80,
        compact: false,
        hasError: false,
        todoCount: 2,
        todoExpanded: false
      })
    ).toBe(false);
    expect(
      hitTestTodoToggle({
        clickRow: 2,
        clickCol: 5,
        columns: 80,
        compact: false,
        hasError: false,
        todoCount: 2,
        todoExpanded: true
      })
    ).toBe(true);
  });
});
