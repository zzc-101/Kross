import { execFile } from 'node:child_process';

import { z } from 'zod';

import {
  fingerprintCommand,
  identifyVerificationCommand
} from '../../verification/verificationCommand';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolHandlerResult
} from '../toolGateway';
import { resolveExistingPathWithinWorkspace } from './paths';

const MAX_OUTPUT_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;

interface VerifyInput {
  command: string;
  timeoutMs?: number;
  cwd?: string;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Validation-worker command runner. Unlike Bash, it never invokes a shell and
 * accepts only one recognized test/typecheck/build/lint command per call.
 */
export function createVerifyTool(
  workspaceRoot: string
): ToolDefinition<VerifyInput> {
  return {
    name: 'Verify',
    description:
      '运行单条测试、类型检查、构建或 lint 命令并返回退出码。不会启动 shell，不接受管道、重定向、命令拼接或后台执行。',
    risk: 'execute',
    category: 'shell',
    timeoutMs: MAX_TIMEOUT_MS,
    retry: false,
    inputSchema: z.object({
      command: z.string().min(1),
      timeoutMs: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
      cwd: z.string().optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '单条可识别验证命令，例如 npm test 或 npm run build'
        },
        timeoutMs: {
          type: 'integer',
          description: `超时毫秒数，最大 ${MAX_TIMEOUT_MS}`
        },
        cwd: { type: 'string', description: '相对 workspace 的子目录' }
      },
      required: ['command'],
      additionalProperties: false
    },
    redactInputForTrace: (input) => {
      const value = input as VerifyInput;
      const verification = identifyVerificationCommand(value.command);
      return {
        commandFingerprint: fingerprintCommand(value.command),
        verificationCommand: verification?.label,
        verificationKinds: verification?.kinds,
        cwd: value.cwd,
        timeoutMs: value.timeoutMs
      };
    },
    execute: async (
      context: ToolExecutionContext<VerifyInput>
    ): Promise<ToolHandlerResult> => {
      const identity = identifyVerificationCommand(context.input.command);
      if (!identity) {
        throw new Error(
          'Verify 仅允许可识别的 test、typecheck、build 或 lint 命令'
        );
      }
      const [executable, ...args] = parseCommandWords(context.input.command);
      if (!executable) {
        throw new Error('Verify command must not be empty');
      }
      const workdir = await resolveExistingPathWithinWorkspace(
        workspaceRoot,
        context.input.cwd ?? '.'
      );
      const { stdout, stderr, code } = await runCommand(
        executable,
        args,
        workdir,
        context.signal,
        context.input.timeoutMs ?? DEFAULT_TIMEOUT_MS
      );
      const raw = `${stdout}${stderr}`.trimEnd();
      const content =
        raw.length > MAX_OUTPUT_CHARS
          ? `${raw.slice(0, MAX_OUTPUT_CHARS)}\n...(输出已截断，超过 ${MAX_OUTPUT_CHARS} 字符)`
          : raw.length > 0
            ? raw
            : '(无输出)';
      return {
        content,
        summary: `exit=${code}, ${raw ? raw.split('\n').length : 0} 行输出`,
        data: { exitCode: code, verificationKinds: identity.kinds }
      };
    }
  };
}

function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd,
        signal,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_CHARS * 2,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (error && !('code' in error && typeof error.code === 'number')) {
          reject(error);
          return;
        }
        resolve({
          stdout,
          stderr,
          code:
            error && 'code' in error && typeof error.code === 'number'
              ? error.code
              : 0
        });
      }
    );
  });
}

/** Minimal argv parser: supports quotes/escapes and rejects shell operators. */
function parseCommandWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    if (';&|<>`$'.includes(char)) {
      throw new Error('Verify 不允许 shell 操作符、重定向或变量展开');
    }
    current += char;
  }
  if (escaped || quote) {
    throw new Error('Verify command contains an incomplete escape or quote');
  }
  if (current) words.push(current);
  return words;
}
