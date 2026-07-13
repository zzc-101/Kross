import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { ToolDefinition } from '../toolGateway';
import {
  resolveExistingPathWithinWorkspace,
  resolveWritablePathWithinWorkspace
} from './paths';

interface MoveInput {
  from: string;
  to: string;
}

export interface MoveResultData {
  from: string;
  to: string;
  mutated: boolean;
}

export function createMoveTool(workspaceRoot: string): ToolDefinition<MoveInput> {
  return {
    name: 'Move',
    description:
      '在工作区内移动或重命名文件/目录（from → to）。自动创建 to 的父目录；两端路径均须在 workspace 内。',
    risk: 'write',
    category: 'filesystem',
    inputSchema: z.object({
      from: z.string().min(1),
      to: z.string().min(1)
    }),
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源路径（相对 workspace）' },
        to: { type: 'string', description: '目标路径（相对 workspace）' }
      },
      required: ['from', 'to'],
      additionalProperties: false
    },
    execute: async ({ input }) => {
      const fromPath = await resolveExistingPathWithinWorkspace(
        workspaceRoot,
        input.from
      );
      const toPath = await resolveWritablePathWithinWorkspace(
        workspaceRoot,
        input.to
      );

      if (fromPath === toPath) {
        return {
          content: `from 与 to 相同，未移动：${input.from}`,
          summary: 'no-op: same path',
          data: {
            from: input.from,
            to: input.to,
            mutated: false
          } satisfies MoveResultData
        };
      }

      await mkdir(dirname(toPath), { recursive: true });
      await rename(fromPath, toPath);

      return {
        content: `已移动：${input.from} → ${input.to}`,
        summary: `moved → ${input.to}`,
        data: {
          from: input.from,
          to: input.to,
          mutated: true
        } satisfies MoveResultData
      };
    }
  };
}
