import { z } from 'zod';

import {
  TODO_STATUSES,
  type TodoStore,
  type TodoStoreSnapshot
} from '../../todo/todoStore';
import type { ToolDefinition } from '../toolGateway';

const todoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(TODO_STATUSES)
});

const writeInputSchema = z.object({
  todos: z.array(todoItemSchema).min(1),
  merge: z.boolean().optional()
});

type WriteInput = z.infer<typeof writeInputSchema>;

function formatSnapshot(snapshot: TodoStoreSnapshot): string {
  if (snapshot.todos.length === 0) {
    return 'Todo list is empty.';
  }
  const lines = snapshot.todos.map(
    (item) => `- (${item.status}) ${item.id}: ${item.content}`
  );
  const { counts } = snapshot;
  return [
    'Todo list updated:',
    ...lines,
    `Counts: pending=${counts.pending}, in_progress=${counts.in_progress}, completed=${counts.completed}, cancelled=${counts.cancelled}`
  ].join('\n');
}

/**
 * Replace or merge session todos. Prefer one in_progress item at a time.
 */
export function createTodoWriteTool(store: TodoStore): ToolDefinition<WriteInput> {
  return {
    name: 'TodoWrite',
    description:
      '创建或更新当前会话的任务清单。用于拆解多步工作：设置 pending / in_progress / completed / cancelled。' +
      '默认 merge=true 按 id 合并；merge=false 时整表替换。建议同时最多一条 in_progress。',
    risk: 'read',
    category: 'agent',
    retry: false,
    inputSchema: writeInputSchema,
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '待写入的 todo 项',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '稳定 id，用于后续更新' },
              content: { type: 'string', description: '任务描述' },
              status: {
                type: 'string',
                enum: [...TODO_STATUSES],
                description: 'pending | in_progress | completed | cancelled'
              }
            },
            required: ['id', 'content', 'status'],
            additionalProperties: false
          }
        },
        merge: {
          type: 'boolean',
          description: 'true（默认）按 id 合并；false 整表替换'
        }
      },
      required: ['todos'],
      additionalProperties: false
    },
    execute: async ({ input }) => {
      const snapshot = store.write({
        todos: input.todos,
        merge: input.merge
      });
      const content = formatSnapshot(snapshot);
      const active =
        snapshot.counts.in_progress > 0
          ? `${snapshot.counts.in_progress} in progress`
          : `${snapshot.counts.pending} pending`;
      return {
        content,
        summary: `Todos: ${snapshot.todos.length} items (${active})`,
        data: snapshot
      };
    }
  };
}

/** Read the current session todo list. */
export function createTodoReadTool(store: TodoStore): ToolDefinition<Record<string, never>> {
  return {
    name: 'TodoRead',
    description: '读取当前会话的任务清单与各状态计数。',
    risk: 'read',
    category: 'agent',
    retry: false,
    inputSchema: z.object({}),
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    execute: async () => {
      const snapshot = store.snapshot();
      if (snapshot.todos.length === 0) {
        return {
          content: 'Todo list is empty.',
          summary: 'Todos: empty',
          data: snapshot
        };
      }
      const content = formatSnapshot(snapshot).replace(
        'Todo list updated:',
        'Current todo list:'
      );
      return {
        content,
        summary: `Todos: ${snapshot.todos.length} items`,
        data: snapshot
      };
    }
  };
}
