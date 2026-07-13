import { lstat, rm } from 'node:fs/promises';

import { z } from 'zod';

import type { ToolDefinition } from '../toolGateway';
import { resolveExistingPathWithinWorkspace } from './paths';

interface DeleteInput {
  path: string;
  /** 目录时是否递归删除；文件忽略该选项 */
  recursive?: boolean;
}

export interface DeleteResultData {
  path: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
  recursive: boolean;
  mutated: boolean;
}

export function createDeleteTool(workspaceRoot: string): ToolDefinition<DeleteInput> {
  return {
    name: 'Delete',
    description:
      '删除工作区内的文件或目录。删除目录需显式 recursive: true；默认不跟随 symlink 删除目标外内容（仅移除链接本身）。',
    risk: 'write',
    category: 'filesystem',
    inputSchema: z.object({
      path: z.string().min(1),
      recursive: z.boolean().optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要删除的相对路径' },
        recursive: {
          type: 'boolean',
          description: '目录是否递归删除，默认 false'
        }
      },
      required: ['path'],
      additionalProperties: false
    },
    execute: async ({ input }) => {
      const filePath = await resolveExistingPathWithinWorkspace(
        workspaceRoot,
        input.path
      );
      const meta = await lstat(filePath);
      const recursive = input.recursive === true;
      const kind = describeKind(meta);
      const displayPath = input.path;

      if (meta.isDirectory() && !meta.isSymbolicLink() && !recursive) {
        return {
          content: `拒绝删除目录 ${displayPath}：未设置 recursive: true（目录可能非空）。`,
          summary: 'refused: directory needs recursive',
          data: {
            path: displayPath,
            kind,
            recursive: false,
            mutated: false
          } satisfies DeleteResultData
        };
      }

      await rm(filePath, {
        recursive: meta.isDirectory() && !meta.isSymbolicLink() ? recursive : false,
        force: false
      });

      return {
        content: `已删除 ${kind}：${displayPath}`,
        summary: `deleted ${kind}`,
        data: {
          path: displayPath,
          kind,
          recursive,
          mutated: true
        } satisfies DeleteResultData
      };
    }
  };
}

function describeKind(
  meta: Awaited<ReturnType<typeof lstat>>
): DeleteResultData['kind'] {
  if (meta.isSymbolicLink()) {
    return 'symlink';
  }
  if (meta.isDirectory()) {
    return 'directory';
  }
  if (meta.isFile()) {
    return 'file';
  }
  return 'other';
}
