import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { ToolDefinition } from '../toolGateway';
import {
  buildCreateDiffPreview,
  buildOverwriteDiffPreview,
  type DiffPreview
} from '../diffPreview';
import {
  countLines,
  formatLineDelta,
  lineDiffStats
} from './fileChangeStats';
import { resolveWritablePathWithinWorkspace } from './paths';

interface WriteInput {
  path: string;
  content: string;
}

export interface WriteResultData {
  path: string;
  created: boolean;
  linesAdded: number;
  linesRemoved: number;
  bytes: number;
  totalLines: number;
  /** TUI 展开用红绿 diff 预览 */
  diffPreview?: DiffPreview;
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
      const displayPath = input.path;
      const previous = await readExisting(filePath);
      const created = previous === null;
      const stats = created
        ? { linesAdded: countLines(input.content), linesRemoved: 0 }
        : lineDiffStats(previous, input.content);
      const bytes = Buffer.byteLength(input.content, 'utf8');
      const totalLines = countLines(input.content);
      const delta = formatLineDelta(stats);

      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, input.content, 'utf8');

      const action = created ? 'created' : 'overwrote';
      const diffPreview: DiffPreview = created
        ? buildCreateDiffPreview(input.content)
        : buildOverwriteDiffPreview(previous ?? '', input.content);
      return {
        content: `已${created ? '创建' : '覆盖'} ${displayPath}（${delta}，${bytes} 字节）`,
        summary: `${action} ${delta}`,
        data: {
          path: displayPath,
          created,
          linesAdded: stats.linesAdded,
          linesRemoved: stats.linesRemoved,
          bytes,
          totalLines,
          diffPreview
        } satisfies WriteResultData
      };
    }
  };
}

async function readExisting(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
