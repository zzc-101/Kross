import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { z } from 'zod';

import type { ToolDefinition } from '../toolGateway';
import { resolveExistingPathWithinWorkspace } from './paths';

const MAX_RESULTS = 1000;
const MAX_VISITED = 20_000;

/** 默认跳过的目录（避免 node_modules 等先耗尽访问配额，导致根文件漏检） */
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 将 glob 模式编译为正则（基于相对 workspace 的 posix 路径）。
 * 支持 `**`（跨目录）、`*`（非 / 单段）、`?`（单个非 / 字符）。
 */
export function compileGlob(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === undefined) {
      break;
    }
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') {
          i += 1;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += escapeRegExp(c);
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * 无路径分隔符的模式（如 test.txt / *.ts）默认按递归搜索：
 * test.txt → ** / test.txt（自动加递归前缀），避免只匹配 workspace 根。
 */
export function normalizeGlobPattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  if (trimmed.includes('/') || trimmed.startsWith('**')) {
    return trimmed;
  }
  return '**/' + trimmed;
}

interface GlobInput {
  pattern: string;
  path?: string;
}

export function createGlobTool(workspaceRoot: string): ToolDefinition<GlobInput> {
  return {
    name: 'Glob',
    description:
      '按 glob 模式（支持 *、**、?）递归列出工作区内的文件路径，返回相对路径，每行一个。无斜杠的模式（如 *.ts、test.txt）会自动按 **/pattern 递归匹配；默认跳过 node_modules、.git 等目录。',
    risk: 'read',
    category: 'filesystem',
    inputSchema: z.object({
      pattern: z.string().min(1),
      path: z.string().optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description:
            'glob 模式，支持 *、**、?；如 test.txt、**/*.ts、src/**/*.tsx'
        },
        path: { type: 'string', description: '起始目录（相对 workspace）' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    execute: async ({ input }) => {
      const base = input.path
        ? await resolveExistingPathWithinWorkspace(workspaceRoot, input.path)
        : await resolveExistingPathWithinWorkspace(workspaceRoot, '.');
      const pattern = normalizeGlobPattern(input.pattern);
      const regex = compileGlob(pattern);
      const matches: string[] = [];
      let visited = 0;

      async function walk(dir: string): Promise<void> {
        if (matches.length >= MAX_RESULTS || visited >= MAX_VISITED) {
          return;
        }
        const entries = await readdir(dir, { withFileTypes: true });
        // 先文件后目录：根目录 test.txt 不会被 node_modules 深度遍历拖死
        const files = entries.filter((entry) => entry.isFile());
        const dirs = entries.filter(
          (entry) => entry.isDirectory() && !IGNORED_DIR_NAMES.has(entry.name)
        );

        for (const entry of files) {
          if (matches.length >= MAX_RESULTS || visited >= MAX_VISITED) {
            return;
          }
          visited += 1;
          const full = join(dir, entry.name);
          const rel = relative(workspaceRoot, full).split(sep).join('/');
          if (regex.test(rel)) {
            matches.push(rel);
          }
        }

        for (const entry of dirs) {
          if (matches.length >= MAX_RESULTS || visited >= MAX_VISITED) {
            return;
          }
          visited += 1;
          const full = join(dir, entry.name);
          const rel = relative(workspaceRoot, full).split(sep).join('/');
          // 目录本身也可被模式命中（少见，但保持行为完整）
          if (regex.test(rel)) {
            matches.push(rel);
          }
          await walk(full);
        }
      }

      await walk(base);

      const truncated = matches.length >= MAX_RESULTS || visited >= MAX_VISITED;
      const body = matches.slice(0, MAX_RESULTS).join('\n') || '(无匹配)';
      const content = truncated
        ? `${body}\n...(已截断，超过 ${MAX_RESULTS} 条或访问上限)`
        : body;

      return {
        content,
        summary: `matched ${matches.length} path(s)`,
        data: {
          pattern,
          matches: matches.length,
          visited,
          truncated
        }
      };
    }
  };
}
