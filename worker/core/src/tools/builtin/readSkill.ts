import { z } from 'zod';

import type { SkillRegistry } from '../../skills/skillRegistry';
import type { ToolDefinition } from '../toolGateway';

interface ReadSkillToolInput {
  id: string;
  rootId?: string;
  resource?: string;
  offset?: number;
  limit?: number;
}

export function createReadSkillTool(
  registry: SkillRegistry
): ToolDefinition<ReadSkillToolInput> {
  const bytesByRun = new Map<string, number>();
  return {
    name: 'ReadSkill',
    description:
      '按需读取已发现 Skill 的 SKILL.md 或其目录内资源。项目 Skill 可用 rootId 选择作用域。只读取，不执行脚本。',
    risk: 'read',
    category: 'skill',
    inputSchema: z.object({
      id: z.string().min(1),
      rootId: z.string().min(1).optional(),
      resource: z.string().min(1).optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().nonnegative().optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Skill id' },
        rootId: { type: 'string', description: '项目 Skill 所属 workspace root id' },
        resource: { type: 'string', description: 'Skill 目录内相对资源路径，默认 SKILL.md' },
        offset: { type: 'integer', description: '起始行（0 基）' },
        limit: { type: 'integer', description: '读取行数' }
      },
      required: ['id'],
      additionalProperties: false
    },
    execute: async ({ input, runId }) => {
      const result = registry.read(input);
      const used = bytesByRun.get(runId) ?? 0;
      const next = used + result.injectedBytes;
      if (next > 128 * 1024) {
        throw new Error('Skill content budget exceeded for this run (128 KiB)');
      }
      bytesByRun.set(runId, next);
      if (bytesByRun.size > 256) {
        bytesByRun.delete(bytesByRun.keys().next().value as string);
      }
      return {
        content: result.content,
        summary: [
          `skill=${result.skill.id}`,
          `scope=${result.skill.rootId}`,
          `resource=${result.resource}`,
          `bytes=${result.injectedBytes}/${result.originalBytes}`,
          result.truncated ? 'truncated' : undefined
        ]
          .filter(Boolean)
          .join(', '),
        data: {
          descriptorId: result.skill.descriptorId,
          rootId: result.skill.rootId,
          resource: result.resource,
          originalBytes: result.originalBytes,
          injectedBytes: result.injectedBytes,
          truncated: result.truncated
        }
      };
    }
  };
}
