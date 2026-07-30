import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { normalize, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import type {
  ToolAccessScope,
  ToolDefinition,
  ToolExecutionContext,
  ToolHandlerResult,
  ToolRisk
} from '../toolGateway';
import {
  resolveExistingPathWithinWorkspace,
  resolveWithinWorkspace,
  ToolBoundaryError
} from './paths';

const MAX_OUTPUT_CHARS = 200_000;
const COMMAND_TIMEOUT_MS = 120_000;

const gitActionSchema = z.enum([
  'status',
  'diff',
  'log',
  'show',
  'branch',
  'add',
  'restore',
  'commit',
  'checkout',
  'stash',
  'fetch',
  'pull',
  'push'
]);

const gitInputSchema = z.object({
  action: gitActionSchema,
  cwd: z.string().optional(),
  paths: z.array(z.string().min(1)).max(100).optional(),
  staged: z.boolean().optional(),
  context: z.number().int().min(0).max(20).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  revision: z.string().min(1).optional(),
  message: z.string().min(1).max(20_000).optional(),
  branch: z.string().min(1).optional(),
  create: z.boolean().optional(),
  remote: z.string().min(1).optional(),
  setUpstream: z.boolean().optional(),
  includeUntracked: z.boolean().optional(),
  stashAction: z.enum(['list', 'push', 'pop']).optional()
});

type GitInput = z.infer<typeof gitInputSchema>;

interface GitCommandOutput {
  stdout: string;
  stderr: string;
  code: number;
}

const readActions = new Set<GitInput['action']>([
  'status',
  'diff',
  'log',
  'show',
  'branch'
]);
const networkActions = new Set<GitInput['action']>([
  'fetch',
  'pull',
  'push'
]);
const confirmationActions = new Set<GitInput['action']>([
  'restore',
  'checkout'
]);

export function createGitTool(
  workspaceRoot: string
): ToolDefinition<GitInput> {
  return {
    name: 'Git',
    description:
      '结构化执行常用 Git 操作：status/diff/log/show/branch、add/restore/commit/checkout/stash、fetch/pull/push。' +
      '不支持强推、hard reset 或 clean；优先使用本工具而不是 Bash。',
    risk: 'read',
    resolveRisk: ({ action, stashAction }): ToolRisk =>
      networkActions.has(action)
        ? 'network'
        : confirmationActions.has(action) ||
            (action === 'stash' && stashAction === 'pop')
          ? 'execute'
        : readActions.has(action)
          ? 'read'
          : 'write',
    category: 'git',
    timeoutMs: COMMAND_TIMEOUT_MS,
    inputSchema: gitInputSchema,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: gitActionSchema.options,
          description: '要执行的 Git 操作'
        },
        cwd: {
          type: 'string',
          description: '仓库目录；完全访问模式可使用绝对路径'
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 100,
          description: 'add/restore/diff/log 可选路径范围'
        },
        staged: {
          type: 'boolean',
          description: 'diff 查看 staged；restore 操作 staged 区'
        },
        context: {
          type: 'integer',
          minimum: 0,
          maximum: 20,
          description: 'diff 上下文行数'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'log 条数'
        },
        revision: {
          type: 'string',
          description: 'show 的 revision，默认 HEAD'
        },
        message: {
          type: 'string',
          description: 'commit message 或 stash message'
        },
        branch: {
          type: 'string',
          description: 'checkout/push 的分支名'
        },
        create: {
          type: 'boolean',
          description: 'checkout 时创建新分支'
        },
        remote: {
          type: 'string',
          description: 'fetch/pull/push 的 remote，默认 origin'
        },
        setUpstream: {
          type: 'boolean',
          description: 'push 时设置 upstream'
        },
        includeUntracked: {
          type: 'boolean',
          description: 'stash push 时包含未跟踪文件'
        },
        stashAction: {
          type: 'string',
          enum: ['list', 'push', 'pop'],
          description: 'stash 子操作，默认 list'
        }
      },
      required: ['action'],
      additionalProperties: false
    },
    redactInputForTrace: (input) => {
      const value = input as GitInput;
      return {
        ...value,
        ...(value.message ? { message: summarizeMessage(value.message) } : {})
      };
    },
    execute: async (context) => executeGit(context, workspaceRoot)
  };
}

async function executeGit(
  context: ToolExecutionContext<GitInput>,
  workspaceRoot: string
): Promise<ToolHandlerResult> {
  const { input } = context;
  validateActionInput(input);
  const workdir = await resolveGitWorkdir(
    workspaceRoot,
    input.cwd,
    context.signal,
    context.accessScope
  );
  if (input.action === 'log') {
    const head = await runGit(
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
      workdir,
      context.signal,
      [1]
    );
    if (head.code === 1) {
      return {
        content: '(no commits)',
        summary: '0 commits',
        data: { action: input.action, exitCode: 0, cwd: workdir }
      };
    }
  }
  const args = buildGitArgs(input, workdir);
  const result = await runGit(
    args,
    workdir,
    context.signal
  );
  const output = formatOutput(`${result.stdout}${result.stderr}`);
  const empty = emptyMessage(input.action);
  return {
    content: output || empty,
    summary: summarizeGitResult(input.action, output, result.code),
    data: {
      action: input.action,
      exitCode: result.code,
      cwd: workdir
    }
  };
}

function validateActionInput(input: GitInput): void {
  if (input.action === 'commit' && !input.message) {
    throw new Error('Git commit 需要 message');
  }
  if (input.action === 'checkout' && !input.branch) {
    throw new Error('Git checkout 需要 branch');
  }
  if (input.action === 'push' && input.setUpstream && !input.branch) {
    throw new Error('Git push 设置 upstream 时需要 branch');
  }
}

function buildGitArgs(input: GitInput, workdir: string): string[] {
  switch (input.action) {
    case 'status':
      return ['status', '--short', '--branch'];
    case 'diff': {
      const args = [
        'diff',
        '--no-ext-diff',
        `--unified=${input.context ?? 3}`
      ];
      if (input.staged) args.push('--cached');
      appendPathspecs(args, workdir, input.paths);
      return args;
    }
    case 'log': {
      const args = [
        'log',
        '--oneline',
        '--no-decorate',
        '-n',
        String(input.limit ?? 20)
      ];
      appendPathspecs(args, workdir, input.paths);
      return args;
    }
    case 'show':
      return [
        'show',
        '--stat',
        '--oneline',
        '--no-renames',
        input.revision ?? 'HEAD'
      ];
    case 'branch':
      return ['branch', '--list', '--verbose', '--no-abbrev'];
    case 'add': {
      const args = ['add'];
      appendPathspecs(args, workdir, input.paths?.length ? input.paths : ['.']);
      return args;
    }
    case 'restore': {
      const args = ['restore'];
      if (input.staged) args.push('--staged');
      appendPathspecs(args, workdir, input.paths?.length ? input.paths : ['.']);
      return args;
    }
    case 'commit':
      return ['commit', '-m', input.message!];
    case 'checkout':
      return input.create
        ? ['switch', '-c', input.branch!]
        : ['switch', input.branch!];
    case 'stash': {
      const action = input.stashAction ?? 'list';
      if (action === 'list') return ['stash', 'list'];
      if (action === 'pop') return ['stash', 'pop'];
      const args = ['stash', 'push'];
      if (input.includeUntracked) args.push('--include-untracked');
      if (input.message) args.push('-m', input.message);
      appendPathspecs(args, workdir, input.paths);
      return args;
    }
    case 'fetch':
      return ['fetch', input.remote ?? 'origin'];
    case 'pull':
      return ['pull', '--ff-only', input.remote ?? 'origin'];
    case 'push': {
      const args = ['push'];
      if (input.setUpstream) args.push('--set-upstream');
      args.push(input.remote ?? 'origin');
      if (input.branch) args.push(input.branch);
      return args;
    }
  }
}

async function resolveGitWorkdir(
  workspaceRoot: string,
  cwd: string | undefined,
  signal: AbortSignal,
  accessScope: ToolAccessScope = 'workspace'
): Promise<string> {
  const workdir = await resolveExistingPathWithinWorkspace(
    workspaceRoot,
    cwd ?? '.',
    accessScope
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
  if (!repositoryRoot) throw new Error('无法确定 Git 仓库根目录');
  if (accessScope === 'workspace') {
    await assertRepositoryWithinWorkspace(workspaceRoot, repositoryRoot);
  }
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

function appendPathspecs(
  args: string[],
  workdir: string,
  inputPaths: string[] | undefined
): void {
  if (!inputPaths?.length) return;
  args.push('--');
  for (const inputPath of inputPaths) {
    const target = resolveWithinWorkspace(workdir, inputPath);
    args.push(relative(workdir, target) || '.');
  }
}

function runGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  acceptedExitCodes: readonly number[] = []
): Promise<GitCommandOutput> {
  return new Promise((resolvePromise, reject) => {
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
            resolvePromise({ stdout, stderr, code });
            return;
          }
          reject(new Error(`Git 命令失败：${stderr.trim() || error.message}`));
          return;
        }
        resolvePromise({ stdout, stderr, code: 0 });
      }
    );
  });
}

function formatOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > MAX_OUTPUT_CHARS
    ? `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n...(输出已截断)`
    : trimmed;
}

function emptyMessage(action: GitInput['action']): string {
  if (action === 'status') return '(working tree clean)';
  if (action === 'diff') return '(no diff)';
  if (action === 'log') return '(no commits)';
  if (action === 'branch') return '(no branches)';
  return '(无输出)';
}

function summarizeGitResult(
  action: GitInput['action'],
  output: string,
  exitCode: number
): string {
  const count = output ? output.split('\n').length : 0;
  if (action === 'status') {
    const changes = output
      ? output.split('\n').filter((line) => !line.startsWith('## ')).length
      : 0;
    return `${changes} change${changes === 1 ? '' : 's'}`;
  }
  if (action === 'log') {
    return `${count} commit${count === 1 ? '' : 's'}`;
  }
  return `${action}: exit=${exitCode}, ${count} line${count === 1 ? '' : 's'}`;
}

function summarizeMessage(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0] ?? '';
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}
