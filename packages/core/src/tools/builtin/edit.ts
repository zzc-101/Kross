import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { ToolDefinition } from '../toolGateway';
import { resolveWithinWorkspace } from './paths';

interface EditInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export function createEditTool(workspaceRoot: string): ToolDefinition<EditInput> {
  return {
    name: 'Edit',
    description:
      '在文件内做精确字符串替换；默认要求 old_string 唯一，可设 replace_all 替换全部匹配。',
    risk: 'write',
    category: 'filesystem',
    inputSchema: z.object({
      path: z.string().min(1),
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件相对路径' },
        old_string: { type: 'string', description: '要被替换的文本' },
        new_string: { type: 'string', description: '替换后的文本' },
        replace_all: { type: 'boolean', description: '是否替换全部匹配' }
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false
    },
    execute: async ({ input }) => {
      const filePath = resolveWithinWorkspace(workspaceRoot, input.path);
      const original = await readFile(filePath, 'utf8');
      const count = original.split(input.old_string).length - 1;

      if (count === 0) {
        return {
          content: `未找到 old_string，未做修改：${filePath}`,
          summary: 'no match'
        };
      }
      if (count > 1 && !input.replace_all) {
        return {
          content: `old_string 出现 ${count} 次，存在歧义未做修改。请提供更多上下文或设置 replace_all: true。`,
          summary: `ambiguous: ${count} matches`
        };
      }

      const updated = input.replace_all
        ? original.split(input.old_string).join(input.new_string)
        : original.replace(input.old_string, input.new_string);

      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, updated, 'utf8');

      return {
        content: `已替换 ${count} 处：${filePath}`,
        summary: `replaced ${count} occurrence(s)`
      };
    }
  };
}
