import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { normalize, relative, sep } from 'node:path';

import { z } from 'zod';

import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolHandlerResult
} from '../toolGateway';
import {
  resolveExistingPathWithinWorkspace,
  resolveWithinWorkspace,
  ToolBoundaryError
} from './paths';

const MAX_OUTPUT_CHARS = 200_000;
const COMMAND_TIMEOUT_MS = 30_000;

interface GitStatusInput {
  cwd?: string;
}

interface GitDiffInput {
  cwd?: string;
  staged?: boolean;
  path?: string;
  context?: number;
}

interface GitLogInput {
  cwd?: string;
  limit?: number;
  path?: string;
}

interface GitCommandOutput {
  stdout: string;
  stderr: string;
  code: number;
}

export function createGitStatusTool(
  workspaceRoot: string
): ToolDefinition<GitStatusInput> {
  return {
    name: 'GitStatus',
    description:
      '读取工作区内 Git 仓库的分支与工作树状态，使用简洁 porcelain 格式。',
    risk: 'read',
    category: 'git',
    inputSchema: z.object({
      cwd: z.string().optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '相对 workspace 的仓库目录' }
      },
      additionalProperties: false
    },
    execute: async (context) => {
      const workdir = await resolveGitWorkdir(
        workspaceRoot,
        context.input.cwd,
        context.signal
      );
      const { stdout } = await runGit(
        ['status', '--short', '--branch'],
        workdir,
        context.signal
      );
      const output = formatOutput(stdout);
      const changeCount = output
        .split('\n')
        .filter((line) => line.length > 0 && !line.startsWith('## ')).length;

      return {
        content: output || '(working tree clean)',
        summary: `${changeCount} change${changeCount === 1 ? '' : 's'}`
      };
    }
  };
}

export function createGitDiffTool(
  workspaceRoot: string
): ToolDefinition<GitDiffInput> {
  return {
    name: 'GitDiff',
    description:
      '读取工作区内 Git 仓库的未暂存或已暂存补丁，可限制路径和上下文行数。',
    risk: 'read',
    category: 'git',
    inputSchema: z.object({
      cwd: z.string().optional(),
      staged: z.boolean().optional(),
      path: z.string().optional(),
      context: z.number().int().min(0).max(20).optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '相对 workspace 的仓库目录' },
        staged: { type: 'boolean', description: '是否读取已暂存差异' },
        path: { type: 'string', description: '相对 cwd 的可选路径范围' },
        context: {
          type: 'integer',
          minimum: 0,
          maximum: 20,
          description: '补丁上下文行数，默认 3'
        }
      },
      additionalProperties: false
    },
    execute: async (context) => {
      const workdir = await resolveGitWorkdir(
        workspaceRoot,
        context.input.cwd,
        context.signal
      );
      const args = [
        'diff',
        '--no-ext-diff',
        `--unified=${context.input.context ?? 3}`
      ];
      if (context.input.staged) {
        args.push('--cached');
      }
      appendPathspec(args, workdir, context.input.path);

      return runGitOutput(context, args, workdir, '(no diff)', 'diff');
    }
  };
}

export function createGitLogTool(
  workspaceRoot: string
): ToolDefinition<GitLogInput> {
  return {
    name: 'GitLog',
    description:
      '读取工作区内 Git 仓库最近的提交摘要，可限制数量和路径。',
    risk: 'read',
    category: 'git',
    inputSchema: z.object({
      cwd: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      path: z.string().optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '相对 workspace 的仓库目录' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: '最多返回的提交数，默认 20'
        },
        path: { type: 'string', description: '相对 cwd 的可选路径范围' }
      },
      additionalProperties: false
    },
    execute: async (context) => {
      const workdir = await resolveGitWorkdir(
        workspaceRoot,
        context.input.cwd,
        context.signal
      );
      const head = await runGit(
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        workdir,
        context.signal,
        [1]
      );
      if (head.code === 1) {
        return {
          content: '(no commits)',
          summary: '0 commits'
        };
      }
      const args = [
        'log',
        '--oneline',
        '--no-decorate',
        '-n',
        String(context.input.limit ?? 20)
      ];
      appendPathspec(args, workdir, context.input.path);

      const result = await runGitOutput(
        context,
        args,
        workdir,
        '(no commits)',
        'commit'
      );
      return result;
    }
  };
}

async function resolveGitWorkdir(
  workspaceRoot: string,
  cwd: string | undefined,
  signal: AbortSignal
): Promise<string> {
  const workdir = await resolveExistingPathWithinWorkspace(
    workspaceRoot,
    cwd ?? '.'
  );
  const workdirStat = await stat(workdir);
  if (!workdirStat.isDirectory()) {
    throw new Error(`Git cwd 不是目录：${cwd ?? '.'}`);
  }

  const { stdout } = await runGit(
    ['rev-parse', '--show-toplevel'],
    workdir,
    signal
  );
  const repositoryRoot = stdout.trim();
  if (!repositoryRoot) {
    throw new Error('无法确定 Git 仓库根目录');
  }
  await assertRepositoryWithinWorkspace(workspaceRoot, repositoryRoot);
  return workdir;
}

async function assertRepositoryWithinWorkspace(
  workspaceRoot: string,
  repositoryRoot: string
): Promise<void> {
  const [realWorkspace, realRepository] = await Promise.all([
    realpath(workspaceRoot),
    realpath(repositoryRoot)
  ]);
  const workspace = normalize(realWorkspace);
  const repository = normalize(realRepository);
  if (repository !== workspace && !repository.startsWith(workspace + sep)) {
    throw new ToolBoundaryError(repositoryRoot);
  }
}

function appendPathspec(
  args: string[],
  workdir: string,
  inputPath: string | undefined
): void {
  if (!inputPath) {
    return;
  }
  const target = resolveWithinWorkspace(workdir, inputPath);
  const pathspec = relative(workdir, target) || '.';
  args.push('--', pathspec);
}

async function runGitOutput<TInput>(
  context: ToolExecutionContext<TInput>,
  args: string[],
  workdir: string,
  emptyMessage: string,
  itemName: string
): Promise<ToolHandlerResult> {
  const { stdout } = await runGit(args, workdir, context.signal);
  const output = formatOutput(stdout);
  const count = output ? output.split('\n').length : 0;
  return {
    content: output || emptyMessage,
    summary: `${count} ${itemName}${count === 1 ? '' : 's'}`
  };
}

function runGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  acceptedExitCodes: readonly number[] = []
): Promise<GitCommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        signal,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_CHARS * 2,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === 'number' ? error.code : -1;
          if (acceptedExitCodes.includes(code)) {
            resolve({ stdout, stderr, code });
            return;
          }
          const message = stderr.trim() || error.message;
          reject(new Error(`Git 命令失败：${message}`));
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      }
    );
  });
}

function formatOutput(output: string): string {
  const trimmed = output.trimEnd();
  if (trimmed.length <= MAX_OUTPUT_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n...(输出已截断，超过 ${MAX_OUTPUT_CHARS} 字符)`;
}
