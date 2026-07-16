import { z } from 'zod';

import type { ProcessManager } from '../../process/processManager';
import type { ToolDefinition } from '../toolGateway';

const processIdSchema = z.string().min(1);

export function createProcessTools(manager: ProcessManager): ToolDefinition[] {
  const start: ToolDefinition = {
    name: 'ProcessStart',
    description:
      '在 workspace cwd 启动可管理的后台 shell 命令并立即返回 opaque processId。命令仍可访问 cwd 外系统资源。',
    risk: 'execute',
    category: 'process',
    retry: false,
    timeoutMs: 30_000,
    inputSchema: z.object({
      command: z.string().min(1),
      cwd: z.string().optional(),
      env: z.record(z.string()).optional(),
      stdin: z.enum(['pipe', 'ignore']).optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        env: { type: 'object', additionalProperties: { type: 'string' } },
        stdin: { type: 'string', enum: ['pipe', 'ignore'] }
      },
      required: ['command'],
      additionalProperties: false
    },
    redactInputForTrace: (input) => {
      const value = input as { command: string; cwd?: string; env?: Record<string, string>; stdin?: string };
      return {
        command: value.command,
        cwd: value.cwd,
        stdin: value.stdin,
        envKeys: value.env ? Object.keys(value.env) : []
      };
    },
    execute: async ({ input, signal }) => {
      const value = input as {
        command: string;
        cwd?: string;
        env?: Record<string, string>;
        stdin?: 'pipe' | 'ignore';
      };
      const result = await manager.start({ ...value, signal });
      return {
        content: JSON.stringify(result, null, 2),
        summary: `${result.processId} started`,
        data: result
      };
    }
  };

  const poll: ToolDefinition = {
    name: 'ProcessPoll',
    description: '按 cursor 增量读取 managed process 的 bounded stdout/stderr 与退出状态。',
    risk: 'read',
    category: 'process',
    retry: false,
    inputSchema: z.object({
      processId: processIdSchema,
      cursor: z.object({ stdout: z.number().int().nonnegative().optional(), stderr: z.number().int().nonnegative().optional() }).optional(),
      maxBytes: z.number().int().positive().max(64 * 1024).optional()
    }),
    execute: async ({ input }) => {
      const value = input as { processId: string; cursor?: { stdout?: number; stderr?: number }; maxBytes?: number };
      const result = manager.poll(value.processId, value.cursor, value.maxBytes);
      const output = [
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : ''
      ].filter(Boolean).join('\n');
      return {
        content: `${output || '(no new output)'}\n\n${JSON.stringify({
          processId: result.processId,
          status: result.status,
          cursor: result.cursor,
          truncated: result.truncated,
          exitCode: result.exitCode,
          signal: result.signal
        })}`,
        summary: `${result.processId} ${result.status}`,
        data: {
          processId: result.processId,
          status: result.status,
          cursor: result.cursor,
          truncated: result.truncated,
          exitCode: result.exitCode,
          signal: result.signal
        }
      };
    }
  };

  const write: ToolDefinition = {
    name: 'ProcessWrite',
    description: '向当前 session 的 managed process stdin 写入文本，可选发送 EOF。',
    risk: 'execute',
    category: 'process',
    retry: false,
    inputSchema: z.object({
      processId: processIdSchema,
      text: z.string().optional(),
      eof: z.boolean().optional()
    }).refine((value) => Boolean(value.text?.length) || value.eof === true, {
      message: 'text or eof=true is required'
    }),
    redactInputForTrace: (input) => {
      const value = input as { processId: string; text?: string; eof?: boolean };
      return { processId: value.processId, textBytes: Buffer.byteLength(value.text ?? ''), eof: value.eof };
    },
    execute: async ({ input }) => {
      const value = input as { processId: string; text?: string; eof?: boolean };
      const result = await manager.write(value.processId, value.text, value.eof);
      return { content: JSON.stringify(result, null, 2), summary: `${result.processId} stdin updated`, data: result };
    }
  };

  const kill: ToolDefinition = {
    name: 'ProcessKill',
    description: '终止当前 session 的 managed process：先 TERM，grace period 后升级 KILL。',
    risk: 'execute',
    category: 'process',
    retry: false,
    inputSchema: z.object({ processId: processIdSchema }),
    execute: async ({ input }) => {
      const { processId } = input as { processId: string };
      const result = await manager.kill(processId);
      return { content: JSON.stringify(result, null, 2), summary: `${result.processId} ${result.status}`, data: result };
    }
  };

  const list: ToolDefinition = {
    name: 'ProcessList',
    description: '列出当前 session 持有的 managed process handles 与状态。',
    risk: 'read',
    category: 'process',
    retry: false,
    inputSchema: z.object({}),
    execute: async () => {
      const processes = manager.list();
      return {
        content: processes.length ? JSON.stringify(processes, null, 2) : '(no managed processes)',
        summary: `${processes.length} managed processes`,
        data: { processes }
      };
    }
  };

  return [start, poll, write, kill, list];
}
