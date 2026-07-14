import { describe, expect, it } from 'vitest';

import { TodoStore } from '../../todo/todoStore';
import { ToolGateway } from '../toolGateway';
import { createTodoReadTool, createTodoWriteTool } from './todo';

describe('TodoWrite / TodoRead tools', () => {
  it('writes, merges, and reads todos via gateway', async () => {
    const store = new TodoStore();
    const gateway = new ToolGateway();
    gateway.register(createTodoWriteTool(store));
    gateway.register(createTodoReadTool(store));

    const written = await gateway.call({
      runId: 'r1',
      name: 'TodoWrite',
      input: {
        todos: [
          { id: '1', content: 'Add TodoWrite', status: 'completed' },
          { id: '2', content: 'Wire context', status: 'in_progress' }
        ]
      }
    });
    expect(written.status).toBe('completed');
    expect(written.summary).toContain('2 items');

    await gateway.call({
      runId: 'r1',
      name: 'TodoWrite',
      input: {
        todos: [{ id: '2', content: 'Wire context', status: 'completed' }]
      }
    });

    const read = await gateway.call({
      runId: 'r1',
      name: 'TodoRead',
      input: {}
    });
    expect(read.content).toContain('completed');
    expect(read.content).toContain('Wire context');
    expect(store.snapshot().counts.completed).toBe(2);
  });
});
