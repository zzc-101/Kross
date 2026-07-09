import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { z } from 'zod';

import type { ToolDefinition } from '../toolGateway';
import { resolveExistingPathWithinWorkspace } from './paths';
import { compileGlob } from './glob';

const DEFAULT_HEAD_LIMIT = 200;
const MAX_FILE_BYTES = 5_000_000;
const MAX_VISITED = 20000;

interface GrepInput {
  pattern: string;
  path?: string;
  include?: string;
  ignoreCase?: boolean;
  headLimit?: number;
}

export function createGrepTool(workspaceRoot: string): ToolDefinition<GrepInput> {
  return {
    name: 'Grep',
    description:
      '在工作区内递归搜索文件内容，返回匹配行（相对路径:行号:内容）。可用 include 按文件名 glob 过滤。',
    risk: 'read',
    category: 'filesystem',
    inputSchema: z.object({
      pattern: z.string().min(1),
      path: z.string().optional(),
      include: z.string().optional(),
      ignoreCase: z.boolean().optional(),
      headLimit: z.number().int().min(1).optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '起始目录（相对 workspace）' },
        include: { type: 'string', description: '按文件名 glob 过滤' },
        ignoreCase: { type: 'boolean', description: '是否忽略大小写' },
        headLimit: { type: 'integer', description: '最大返回行数' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    execute: async ({ input }) => {
      const base = input.path
        ? await resolveExistingPathWithinWorkspace(workspaceRoot, input.path)
        : await resolveExistingPathWithinWorkspace(workspaceRoot, '.');
      const regex = new RegExp(input.pattern, input.ignoreCase ? 'i' : '');
      const includeRegex = input.include
        ? compileGlob(input.include)
        : undefined;
      const headLimit = input.headLimit ?? DEFAULT_HEAD_LIMIT;
      const results: string[] = [];
      let visited = 0;

      async function walk(dir: string): Promise<void> {
        if (results.length >= headLimit || visited >= MAX_VISITED) {
          return;
        }
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= headLimit || visited >= MAX_VISITED) {
            return;
          }
          visited += 1;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
            continue;
          }
          if (!entry.isFile()) {
            continue;
          }
          const rel = relative(workspaceRoot, full).split(sep).join('/');
          if (includeRegex && !includeRegex.test(rel)) {
            continue;
          }
          let content: string;
          try {
            const info = await stat(full);
            if (info.size > MAX_FILE_BYTES) {
              continue;
            }
            content = await readFile(full, 'utf8');
          } catch {
            continue;
          }
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i += 1) {
            if (results.length >= headLimit) {
              break;
            }
            const line = lines[i];
            if (line !== undefined && regex.test(line)) {
              results.push(`${rel}:${i + 1}:${line}`);
            }
          }
        }
      }

      await walk(base);

      const truncated = results.length >= headLimit || visited >= MAX_VISITED;
      const body = results.join('\n') || '(无匹配)';
      const content = truncated
        ? `${body}\n...(已截断，超过 ${headLimit} 条)`
        : body;

      return {
        content,
        summary: `matched ${results.length} line(s)`
      };
    }
  };
}
