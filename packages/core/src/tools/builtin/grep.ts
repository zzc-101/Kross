import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { z } from 'zod';

import type { ToolDefinition } from '../toolGateway';
import { resolveExistingPathWithinWorkspace } from './paths';
import { compileGlobMatcher } from './glob';

const DEFAULT_HEAD_LIMIT = 200;
const MAX_FILE_BYTES = 5_000_000;
const MAX_VISITED = 20_000;

/** 与 Glob/List 对齐：默认不钻入噪音目录 */
const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.jj',
  '.turbo',
  '.next',
  '.nuxt',
  '.cache',
  '.venv',
  'venv',
  'dist',
  'build',
  'coverage',
  'out',
  'tmp',
  '.idea',
  '.vscode'
]);

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
      '在工作区内递归搜索文件内容（纯 JS）。返回 相对路径:行号:内容。' +
      '可用 include 按文件名 glob 过滤（支持 {ts,js} 花括号）。' +
      '默认跳过 node_modules/.git/dist 等目录。优先用 Rg。',
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
        path: { type: 'string', description: '起始目录或单文件（相对 workspace）' },
        include: {
          type: 'string',
          description: '按文件名 glob 过滤，如 *.ts 或 *.{ts,tsx}'
        },
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
      const includeMatch = input.include
        ? compileGlobMatcher(input.include)
        : undefined;
      const headLimit = input.headLimit ?? DEFAULT_HEAD_LIMIT;
      const results: string[] = [];
      let visited = 0;
      let hitVisitCap = false;

      async function searchFile(full: string): Promise<void> {
        if (results.length >= headLimit || visited >= MAX_VISITED) {
          if (visited >= MAX_VISITED) {
            hitVisitCap = true;
          }
          return;
        }
        visited += 1;
        const rel = relative(workspaceRoot, full).split(sep).join('/') || '.';
        if (includeMatch && !includeMatch(rel)) {
          return;
        }
        let content: string;
        try {
          const info = await stat(full);
          if (!info.isFile() || info.size > MAX_FILE_BYTES) {
            return;
          }
          content = await readFile(full, 'utf8');
        } catch {
          return;
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

      async function walk(dir: string): Promise<void> {
        if (results.length >= headLimit || visited >= MAX_VISITED) {
          if (visited >= MAX_VISITED) {
            hitVisitCap = true;
          }
          return;
        }
        const entries = await readdir(dir, { withFileTypes: true });
        const files = entries.filter((entry) => entry.isFile());
        const dirs = entries.filter(
          (entry) => entry.isDirectory() && !IGNORED_DIR_NAMES.has(entry.name)
        );

        for (const entry of files) {
          if (results.length >= headLimit || visited >= MAX_VISITED) {
            if (visited >= MAX_VISITED) {
              hitVisitCap = true;
            }
            return;
          }
          await searchFile(join(dir, entry.name));
        }

        for (const entry of dirs) {
          if (results.length >= headLimit || visited >= MAX_VISITED) {
            if (visited >= MAX_VISITED) {
              hitVisitCap = true;
            }
            return;
          }
          visited += 1;
          await walk(join(dir, entry.name));
        }
      }

      const baseInfo = await stat(base);
      if (baseInfo.isFile()) {
        await searchFile(base);
      } else {
        await walk(base);
      }

      const hitHead = results.length >= headLimit;
      const truncated = hitHead || hitVisitCap;
      let body = results.join('\n') || '(无匹配)';
      if (truncated) {
        if (hitHead) {
          body += `\n...(已截断，超过 ${headLimit} 条匹配)`;
        } else if (hitVisitCap && results.length === 0) {
          body +=
            '\n...(已达访问上限且无匹配：可能目录过大；请缩小 path 或加 include 过滤，或改用 Rg)';
        } else if (hitVisitCap) {
          body += '\n...(已达文件访问上限，结果可能不完整；请缩小范围或改用 Rg)';
        }
      }

      return {
        content: body,
        summary: `matched ${results.length} line(s)${truncated ? ' (truncated)' : ''}`
      };
    }
  };
}
