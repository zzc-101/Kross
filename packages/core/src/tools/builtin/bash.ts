import { exec } from 'node:child_process';

import { z } from 'zod';

import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolHandlerResult
} from '../toolGateway';
import { TIMEOUT_ONLY_RETRY_POLICY } from '../toolRetry';
import { resolveExistingPathWithinWorkspace } from './paths';

const MAX_OUTPUT_CHARS = 200_000;

interface BashInput {
  command: string;
  timeoutMs?: number;
  cwd?: string;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number;
}

function runCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<CommandOutput> {
  return new Promise((resolvePromise, reject) => {
    const child = exec(command, {
      cwd,
      signal,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_CHARS * 2,
      encoding: 'utf8'
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise({ stdout, stderr, code: code ?? 0 });
    });
  });
}

export function createBashTool(workspaceRoot: string): ToolDefinition<BashInput> {
  return {
    name: 'Bash',
    description:
      '以工作区内目录作为 cwd 启动 shell 命令，返回合并后的标准输出与标准错误。命令本身仍可能访问 cwd 外资源，需由审批策略约束。',
    risk: 'execute',
    category: 'shell',
    timeoutMs: 120_000,
    // 仅网关层超时可重试；exit≠0 是合法结果，不会触发重试
    retry: TIMEOUT_ONLY_RETRY_POLICY,
    inputSchema: z.object({
      command: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
      cwd: z.string().optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        timeoutMs: { type: 'integer', description: '超时毫秒数' },
        cwd: { type: 'string', description: '相对 workspace 的子目录' }
      },
      required: ['command'],
      additionalProperties: false
    },
    execute: async (
      context: ToolExecutionContext<BashInput>
    ): Promise<ToolHandlerResult> => {
      const { command, cwd, timeoutMs } = context.input;
      const workdir = cwd
        ? await resolveExistingPathWithinWorkspace(workspaceRoot, cwd)
        : await resolveExistingPathWithinWorkspace(workspaceRoot, '.');

      const { stdout, stderr, code } = await runCommand(
        command,
        workdir,
        context.signal,
        timeoutMs ?? 120_000
      );

      const raw = `${stdout}${stderr}`.trimEnd();
      const content =
        raw.length > MAX_OUTPUT_CHARS
          ? `${raw.slice(0, MAX_OUTPUT_CHARS)}\n...(输出已截断，超过 ${MAX_OUTPUT_CHARS} 字符)`
          : raw.length > 0
            ? raw
            : '(无输出)';
      const lineCount = raw.split('\n').length;

      return {
        content,
        summary: `exit=${code}, ${lineCount} 行输出`
      };
    }
  };
}
