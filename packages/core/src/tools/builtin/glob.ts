import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { z } from 'zod';

import type { ToolDefinition } from '../toolGateway';
import { resolveExistingPathWithinWorkspace } from './paths';

const MAX_RESULTS = 1000;
const MAX_VISITED = 20000;

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

interface GlobInput {
  pattern: string;
  path?: string;
}

export function createGlobTool(workspaceRoot: string): ToolDefinition<GlobInput> {
  return {
    name: 'Glob',
    description:
      '按 glob 模式（支持 *、**、?）递归列出工作区内的文件路径，返回相对路径，每行一个。',
    risk: 'read',
    category: 'filesystem',
    inputSchema: z.object({
      pattern: z.string().min(1),
      path: z.string().optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，支持 *、**、?' },
        path: { type: 'string', description: '起始目录（相对 workspace）' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    execute: async ({ input }) => {
      const base = input.path
        ? await resolveExistingPathWithinWorkspace(workspaceRoot, input.path)
        : await resolveExistingPathWithinWorkspace(workspaceRoot, '.');
      const regex = compileGlob(input.pattern);
      const matches: string[] = [];
      let visited = 0;

      async function walk(dir: string): Promise<void> {
        if (matches.length >= MAX_RESULTS || visited >= MAX_VISITED) {
          return;
        }
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= MAX_RESULTS || visited >= MAX_VISITED) {
            return;
          }
          visited += 1;
          const full = join(dir, entry.name);
          const rel = relative(workspaceRoot, full).split(sep).join('/');
          if (regex.test(rel)) {
            matches.push(rel);
          }
          if (entry.isDirectory()) {
            await walk(full);
          }
        }
      }

      await walk(base);

      const truncated = matches.length >= MAX_RESULTS || visited >= MAX_VISITED;
      const body = matches.slice(0, MAX_RESULTS).join('\n') || '(无匹配)';
      const content = truncated
        ? `${body}\n...(已截断，超过 ${MAX_RESULTS} 条)`
        : body;

      return {
        content,
        summary: `matched ${matches.length} path(s)`
      };
    }
  };
}
