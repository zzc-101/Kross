import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, sep } from 'node:path';

import { z } from 'zod';

import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolHandlerResult
} from '../toolGateway';
import { resolveExistingPathWithinWorkspace } from './paths';

const DEFAULT_HEAD_LIMIT = 200;
const MAX_OUTPUT_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 60_000;

const requireFromHere = createRequire(import.meta.url);

/**
 * 解析可用的 rg 二进制：
 * 1. 显式覆盖
 * 2. 依赖内置的 @vscode/ripgrep（随 npm 安装，客户无需单独装）
 * 3. PATH 上的 `rg`
 */
export function resolveRgBinary(override?: string): string {
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  const bundled = tryBundledRgPath();
  if (bundled) {
    return bundled;
  }
  return 'rg';
}

function tryBundledRgPath(): string | undefined {
  try {
    const mod = requireFromHere('@vscode/ripgrep') as { rgPath?: string };
    if (typeof mod.rgPath === 'string' && existsSync(mod.rgPath)) {
      return mod.rgPath;
    }
  } catch {
    // 依赖未装或平台包缺失时回退 PATH
  }
  return undefined;
}

export interface RgInput {
  /** 正则/字面量搜索模式；filesOnly 时可省略 */
  pattern?: string;
  /** 搜索根路径（相对 workspace，默认工作区根） */
  path?: string;
  /** 文件 glob 过滤（可多条，对应 rg -g） */
  glob?: string | string[];
  /** 按语言/类型过滤（对应 rg -t，如 ts、py） */
  type?: string;
  ignoreCase?: boolean;
  /** 将 pattern 视为固定字符串（-F），不做正则 */
  fixedString?: boolean;
  /** 仅列出文件（--files），相当于快速 find/Glob */
  filesOnly?: boolean;
  multiline?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  /** 输出最大行数（工具侧截断） */
  headLimit?: number;
  /** 是否包含隐藏文件（--hidden） */
  hidden?: boolean;
  /** 是否不尊重 .gitignore（--no-ignore） */
  noIgnore?: boolean;
}

export interface CreateRgToolOptions {
  /**
   * 覆盖 rg 二进制路径。
   * 默认优先用依赖内置的 @vscode/ripgrep，其次 PATH 上的 `rg`。
   */
  rgBinary?: string;
  /** 注入执行器，便于无 rg 环境单测 */
  runCommand?: (
    binary: string,
    args: string[],
    cwd: string,
    signal: AbortSignal,
    timeoutMs: number
  ) => Promise<RgCommandOutput>;
}

export interface RgCommandOutput {
  stdout: string;
  stderr: string;
  code: number | null;
  error?: NodeJS.ErrnoException;
}

/**
 * 将工具入参编译为 rg argv（不含 binary）。
 * 始终使用 argv 数组，避免 shell 注入。
 */
export function buildRgArgs(input: RgInput, searchPath: string): string[] {
  const args: string[] = ['--color=never'];
  const filesOnly = input.filesOnly === true;

  if (input.hidden) {
    args.push('--hidden');
  }
  if (input.noIgnore) {
    args.push('--no-ignore');
  }

  const globs = normalizeGlobs(input.glob);
  for (const g of globs) {
    args.push('-g', g);
  }
  if (input.type?.trim()) {
    args.push('-t', input.type.trim());
  }

  if (filesOnly) {
    args.push('--files');
    args.push(searchPath);
    return args;
  }

  args.push('--line-number', '--no-heading', '--with-filename');
  if (input.ignoreCase) {
    args.push('-i');
  }
  if (input.fixedString) {
    args.push('-F');
  }
  if (input.multiline) {
    args.push('-U', '--multiline-dotall');
  }
  if (input.contextBefore !== undefined) {
    args.push('-B', String(input.contextBefore));
  }
  if (input.contextAfter !== undefined) {
    args.push('-A', String(input.contextAfter));
  }

  const pattern = input.pattern ?? '';
  // -e 保证以 - 开头的 pattern 不被当成 flag
  args.push('-e', pattern);
  args.push(searchPath);
  return args;
}

function normalizeGlobs(glob: string | string[] | undefined): string[] {
  if (glob === undefined) {
    return [];
  }
  const list = Array.isArray(glob) ? glob : [glob];
  return list.map((item) => item.trim()).filter((item) => item.length > 0);
}

/** 把 rg 输出的绝对路径压成相对 workspace，便于模型与 UI 阅读。 */
function relativizeRgLine(line: string, workspaceRoot: string): string {
  const root = workspaceRoot.endsWith(sep)
    ? workspaceRoot
    : workspaceRoot + sep;
  if (line.startsWith(root)) {
    return line.slice(root.length).split(sep).join('/');
  }
  if (line.startsWith(workspaceRoot + ':') || line === workspaceRoot) {
    const rest = line.slice(workspaceRoot.length);
    return rest.startsWith(':') ? `.${rest}` : rest.replace(/^\//, '') || '.';
  }
  return line;
}

export function runRgCommand(
  binary: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<RgCommandOutput> {
  return new Promise((resolvePromise) => {
    const child = spawn(binary, args, {
      cwd,
      signal,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill('SIGTERM');
      settled = true;
      resolvePromise({
        stdout,
        stderr: stderr || `rg timed out after ${timeoutMs}ms`,
        code: null,
        error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' })
      });
    }, timeoutMs);

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code: null, error });
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code: code ?? 0 });
    });
  });
}

/**
 * 基于 ripgrep 的高速搜索工具：内容检索 + 文件枚举（--files）。
 * 默认使用 npm 依赖内置的 rg 二进制（@vscode/ripgrep），客户无需单独安装。
 * 比内置 JS Grep/Glob 更快，并默认尊重 .gitignore。
 */
export function createRgTool(
  workspaceRoot: string,
  options: CreateRgToolOptions = {}
): ToolDefinition<RgInput> {
  const rgBinary = resolveRgBinary(options.rgBinary);
  const runCommand = options.runCommand ?? runRgCommand;

  return {
    name: 'Rg',
    description:
      '用 ripgrep（rg）在工作区内高速搜索（二进制已随应用内置，无需系统安装）。' +
      '默认做内容检索（比 Grep 更快，尊重 .gitignore）；' +
      'filesOnly=true 时仅列文件（可替代 Glob/find）。' +
      '优先于 Grep/Glob 使用。',
    risk: 'read',
    category: 'filesystem',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    inputSchema: z
      .object({
        pattern: z.string().optional(),
        path: z.string().optional(),
        glob: z.union([z.string(), z.array(z.string())]).optional(),
        type: z.string().optional(),
        ignoreCase: z.boolean().optional(),
        fixedString: z.boolean().optional(),
        filesOnly: z.boolean().optional(),
        multiline: z.boolean().optional(),
        contextBefore: z.number().int().min(0).max(20).optional(),
        contextAfter: z.number().int().min(0).max(20).optional(),
        headLimit: z.number().int().min(1).optional(),
        hidden: z.boolean().optional(),
        noIgnore: z.boolean().optional()
      })
      .superRefine((value, ctx) => {
        if (value.filesOnly !== true) {
          if (value.pattern === undefined || value.pattern.length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'pattern is required unless filesOnly=true',
              path: ['pattern']
            });
          }
        }
      }),
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: '搜索模式（正则；fixedString=true 时为字面量）。filesOnly 时可省略'
        },
        path: {
          type: 'string',
          description: '搜索根路径（相对 workspace）'
        },
        glob: {
          description: '文件过滤 glob，如 "*.ts" 或 ["*.ts","*.tsx"]（rg -g）',
          anyOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' } }
          ]
        },
        type: {
          type: 'string',
          description: '按语言类型过滤（rg -t，如 ts、py、md）'
        },
        ignoreCase: { type: 'boolean', description: '忽略大小写（-i）' },
        fixedString: {
          type: 'boolean',
          description: '固定字符串匹配（-F），不做正则'
        },
        filesOnly: {
          type: 'boolean',
          description: '仅列出匹配文件路径（--files），相当于 find/Glob'
        },
        multiline: { type: 'boolean', description: '多行匹配（-U）' },
        contextBefore: {
          type: 'integer',
          description: '匹配行前上下文行数（-B，0-20）'
        },
        contextAfter: {
          type: 'integer',
          description: '匹配行后上下文行数（-A，0-20）'
        },
        headLimit: { type: 'integer', description: '最大返回行数' },
        hidden: { type: 'boolean', description: '包含隐藏文件（--hidden）' },
        noIgnore: {
          type: 'boolean',
          description: '不使用 .gitignore（--no-ignore）'
        }
      },
      required: [],
      additionalProperties: false
    },
    execute: async (
      context: ToolExecutionContext<RgInput>
    ): Promise<ToolHandlerResult> => {
      const input = context.input;
      const searchRoot = input.path
        ? await resolveExistingPathWithinWorkspace(workspaceRoot, input.path)
        : await resolveExistingPathWithinWorkspace(workspaceRoot, '.');

      const args = buildRgArgs(input, searchRoot);
      const headLimit = input.headLimit ?? DEFAULT_HEAD_LIMIT;
      const { stdout, stderr, code, error } = await runCommand(
        rgBinary,
        args,
        workspaceRoot,
        context.signal,
        DEFAULT_TIMEOUT_MS
      );

      if (error?.code === 'ENOENT') {
        return {
          content:
            'ERROR: 无法启动 rg（ripgrep）。' +
            '应用应已通过 @vscode/ripgrep 内置二进制；' +
            '若仍失败请重装依赖，或改用内置 Grep / Glob 工具。\n' +
            `尝试路径: ${rgBinary}`,
          summary: 'rg not found'
        };
      }
      if (error?.code === 'ETIMEDOUT') {
        return {
          content: `ERROR: rg 超时（${DEFAULT_TIMEOUT_MS}ms）\n${stderr}`.trim(),
          summary: 'rg timed out'
        };
      }
      if (error) {
        return {
          content: `ERROR: 无法启动 rg: ${error.message}`,
          summary: 'rg spawn failed'
        };
      }

      // rg: 0=有匹配, 1=无匹配, ≥2=错误
      if (code !== null && code >= 2) {
        const detail = (stderr || stdout || 'rg failed').trim();
        return {
          content: `ERROR: rg 退出码 ${code}\n${detail}`,
          summary: `rg exit=${code}`
        };
      }

      const rawLines =
        stdout.length === 0
          ? []
          : stdout
              .replace(/\n$/, '')
              .split('\n')
              .filter((line) => line.length > 0)
              .map((line) => relativizeRgLine(line, workspaceRoot));
      const truncated = rawLines.length > headLimit;
      const lines = truncated ? rawLines.slice(0, headLimit) : rawLines;
      let body = lines.join('\n') || '(无匹配)';
      if (truncated) {
        body += `\n...(已截断，超过 ${headLimit} 条)`;
      }
      if (body.length > MAX_OUTPUT_CHARS) {
        body = `${body.slice(0, MAX_OUTPUT_CHARS)}\n...(输出已截断，超过 ${MAX_OUTPUT_CHARS} 字符)`;
      }

      const mode = input.filesOnly ? 'files' : 'matches';
      return {
        content: body,
        summary: `${mode}=${lines.length}${truncated ? '+' : ''}`,
        data: {
          mode,
          count: lines.length,
          truncated,
          exitCode: code
        }
      };
    }
  };
}
