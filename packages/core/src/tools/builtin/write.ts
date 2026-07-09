import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { ToolDefinition } from '../toolGateway';
import { resolveWritablePathWithinWorkspace } from './paths';

interface WriteInput {
  path: string;
  content: string;
}

export function createWriteTool(workspaceRoot: string): ToolDefinition<WriteInput> {
  return {
    name: 'Write',
    description: '写入或覆盖工作区内的文件，自动创建不存在的父目录。',
    risk: 'write',
    category: 'filesystem',
    inputSchema: z.object({
      path: z.string().min(1),
      content: z.string()
    }),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件相对路径' },
        content: { type: 'string', description: '要写入的文件内容' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    execute: async ({ input }) => {
      const filePath = await resolveWritablePathWithinWorkspace(workspaceRoot, input.path);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, input.content, 'utf8');
      const bytes = Buffer.byteLength(input.content, 'utf8');
      return {
        content: `已写入 ${filePath}（${bytes} 字节）`,
        summary: `wrote ${bytes} bytes`
      };
    }
  };
}
