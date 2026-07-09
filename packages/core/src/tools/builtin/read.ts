import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { ToolDefinition } from '../toolGateway';
import { resolveWithinWorkspace } from './paths';

const MAX_BYTES = 1_000_000;

interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export function createReadTool(workspaceRoot: string): ToolDefinition<ReadInput> {
  return {
    name: 'Read',
    description: '读取工作区内文件内容，可按行偏移与行数截取。',
    risk: 'read',
    category: 'filesystem',
    inputSchema: z.object({
      path: z.string().min(1),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件相对路径' },
        offset: { type: 'integer', description: '起始行（0 基）' },
        limit: { type: 'integer', description: '读取行数' }
      },
      required: ['path'],
      additionalProperties: false
    },
    execute: async ({ input }) => {
      const filePath = resolveWithinWorkspace(workspaceRoot, input.path);
      const buffer = await readFile(filePath);

      if (buffer.byteLength > MAX_BYTES) {
        return {
          content: `文件过大（${buffer.byteLength} 字节 > ${MAX_BYTES}），请用 offset/limit 分段读取。`,
          summary: 'file too large'
        };
      }

      const lines = buffer.toString('utf8').split('\n');
      const start = input.offset ?? 0;
      const end = input.limit != null ? start + input.limit : lines.length;
      const selected = lines.slice(start, end);
      const content = selected.join('\n');

      return {
        content,
        summary: `read ${selected.length} lines`
      };
    }
  };
}
