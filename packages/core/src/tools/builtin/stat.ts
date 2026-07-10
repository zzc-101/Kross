import { lstat } from 'node:fs/promises';
import { relative, sep } from 'node:path';

import { z } from 'zod';

import type { ToolDefinition } from '../toolGateway';
import { resolveExistingPathWithinWorkspace } from './paths';

interface StatInput {
  path: string;
}

export function createStatTool(workspaceRoot: string): ToolDefinition<StatInput> {
  return {
    name: 'Stat',
    description:
      '读取工作区内文件、目录或符号链接的类型、大小、权限和时间信息。',
    risk: 'read',
    category: 'filesystem',
    inputSchema: z.object({
      path: z.string().min(1)
    }),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目标路径（相对 workspace）' }
      },
      required: ['path'],
      additionalProperties: false
    },
    execute: async ({ input }) => {
      const target = await resolveExistingPathWithinWorkspace(
        workspaceRoot,
        input.path
      );
      const metadata = await lstat(target);
      const type = describeType(metadata);
      const data = {
        path: relative(workspaceRoot, target).split(sep).join('/') || '.',
        type,
        size: metadata.size,
        mode: (metadata.mode & 0o777).toString(8).padStart(3, '0'),
        modifiedAt: metadata.mtime.toISOString(),
        createdAt: metadata.birthtime.toISOString()
      };

      return {
        content: JSON.stringify(data, null, 2),
        summary: `${type}, ${metadata.size} bytes`,
        data
      };
    }
  };
}

function describeType(metadata: Awaited<ReturnType<typeof lstat>>): string {
  if (metadata.isFile()) {
    return 'file';
  }
  if (metadata.isDirectory()) {
    return 'directory';
  }
  if (metadata.isSymbolicLink()) {
    return 'symlink';
  }
  if (metadata.isSocket()) {
    return 'socket';
  }
  if (metadata.isFIFO()) {
    return 'fifo';
  }
  if (metadata.isCharacterDevice()) {
    return 'character-device';
  }
  if (metadata.isBlockDevice()) {
    return 'block-device';
  }
  return 'unknown';
}
