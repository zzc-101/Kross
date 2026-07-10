import { lstat, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { z } from 'zod';

import type { ToolDefinition } from '../toolGateway';
import { resolveExistingPathWithinWorkspace } from './paths';

const DEFAULT_DEPTH = 1;
const DEFAULT_LIMIT = 200;
const MAX_DEPTH = 5;
const MAX_LIMIT = 1000;

interface ListInput {
  path?: string;
  depth?: number;
  limit?: number;
  includeHidden?: boolean;
}

export function createListTool(workspaceRoot: string): ToolDefinition<ListInput> {
  return {
    name: 'List',
    description:
      '按层级列出工作区内目录内容，包含文件类型和大小；默认隐藏点文件且不会跟随符号链接遍历。',
    risk: 'read',
    category: 'filesystem',
    inputSchema: z.object({
      path: z.string().optional(),
      depth: z.number().int().min(1).max(MAX_DEPTH).optional(),
      limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
      includeHidden: z.boolean().optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '起始目录（相对 workspace）' },
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_DEPTH,
          description: `遍历层数，默认 ${DEFAULT_DEPTH}`
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `最多返回条目数，默认 ${DEFAULT_LIMIT}`
        },
        includeHidden: {
          type: 'boolean',
          description: '是否包含名称以 . 开头的条目，默认 false'
        }
      },
      additionalProperties: false
    },
    execute: async ({ input }) => {
      const base = await resolveExistingPathWithinWorkspace(
        workspaceRoot,
        input.path ?? '.'
      );
      const baseStat = await stat(base);
      if (!baseStat.isDirectory()) {
        throw new Error(`List 起始路径不是目录：${input.path ?? '.'}`);
      }

      const maxDepth = input.depth ?? DEFAULT_DEPTH;
      const limit = input.limit ?? DEFAULT_LIMIT;
      const lines: string[] = [];
      let truncated = false;

      async function walk(directory: string, depth: number): Promise<void> {
        const entries = (await readdir(directory, { withFileTypes: true })).sort(
          (left, right) => left.name.localeCompare(right.name)
        );

        for (const entry of entries) {
          if (!input.includeHidden && entry.name.startsWith('.')) {
            continue;
          }
          if (lines.length >= limit) {
            truncated = true;
            return;
          }

          const fullPath = join(directory, entry.name);
          const displayPath = relative(workspaceRoot, fullPath)
            .split(sep)
            .join('/');
          const entryStat = await lstat(fullPath);

          if (entryStat.isSymbolicLink()) {
            lines.push(`[link] ${displayPath}`);
            continue;
          }
          if (entryStat.isDirectory()) {
            lines.push(`[dir] ${displayPath}/`);
            if (depth < maxDepth) {
              await walk(fullPath, depth + 1);
              if (truncated) {
                return;
              }
            }
            continue;
          }
          lines.push(`[file] ${displayPath} (${entryStat.size} bytes)`);
        }
      }

      await walk(base, 1);
      const body = lines.join('\n') || '(空目录)';
      const content = truncated
        ? `${body}\n...(已截断，最多返回 ${limit} 条)`
        : body;

      return {
        content,
        summary: `listed ${lines.length} entries${truncated ? ' (truncated)' : ''}`,
        data: {
          entries: lines.length,
          truncated
        }
      };
    }
  };
}
