import { describe, expect, it } from 'vitest';

import { TodoStore } from './todoStore';

describe('TodoStore', () => {
  it('merges todos by id by default', () => {
    const store = new TodoStore();
    store.write({
      todos: [
        { id: '1', content: 'A', status: 'pending' },
        { id: '2', content: 'B', status: 'in_progress' }
      ]
    });
    store.write({
      todos: [{ id: '1', content: 'A done', status: 'completed' }]
    });

    expect(store.list()).toEqual([
      { id: '1', content: 'A done', status: 'completed' },
      { id: '2', content: 'B', status: 'in_progress' }
    ]);
    expect(store.snapshot().counts.completed).toBe(1);
    expect(store.snapshot().counts.in_progress).toBe(1);
  });

  it('replaces the full list when merge is false', () => {
    const store = new TodoStore();
    store.write({
      todos: [
        { id: '1', content: 'A', status: 'pending' },
        { id: '2', content: 'B', status: 'pending' }
      ]
    });
    store.write({
      merge: false,
      todos: [{ id: '3', content: 'C', status: 'pending' }]
    });
    expect(store.list()).toEqual([
      { id: '3', content: 'C', status: 'pending' }
    ]);
  });

  it('formats a prompt block and clears', () => {
    const store = new TodoStore();
    expect(store.formatForPrompt()).toBe('');
    store.write({
      todos: [{ id: 't1', content: 'Ship todo tool', status: 'in_progress' }]
    });
    const text = store.formatForPrompt();
    expect(text).toContain('[~] t1: Ship todo tool');
    expect(text).toContain('Progress:');
    store.clear();
    expect(store.formatForPrompt()).toBe('');
  });
});
