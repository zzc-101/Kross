import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { ToolDefinition } from '../toolGateway';
import {
  resolveExistingPathWithinWorkspace,
  resolveWritablePathWithinWorkspace
} from './paths';
import type {
  MutationCoordinator,
  MutationService
} from '../../mutations/mutationService';
import { recordToolMutation } from './mutationRecorder';

interface MoveInput {
  from: string;
  to: string;
}

export interface MoveResultData {
  from: string;
  to: string;
  mutated: boolean;
}

export function createMoveTool(
  workspaceRoot: string,
  mutations?: MutationService,
  systemMutations?: MutationCoordinator
): ToolDefinition<MoveInput> {
  return {
    name: 'Move',
    description:
      '移动或重命名文件/目录（from → to），自动创建目标父目录。默认限当前工作区；完全访问模式支持任意绝对路径。',
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
    execute: async ({ input, runId, accessScope }) => {
      const fromPath = await resolveExistingPathWithinWorkspace(
        workspaceRoot,
        input.from,
        accessScope
      );
      const toPath = await resolveWritablePathWithinWorkspace(
        workspaceRoot,
        input.to,
        accessScope
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

      const move = async () => {
        await mkdir(dirname(toPath), { recursive: true });
        await rename(fromPath, toPath);
      };
      await recordToolMutation({
        recorders: { workspace: mutations, system: systemMutations },
        accessScope,
        runId,
        toolName: 'Move',
        displayPaths: [input.from, input.to],
        absolutePaths: [fromPath, toPath],
        action: move
      });

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
