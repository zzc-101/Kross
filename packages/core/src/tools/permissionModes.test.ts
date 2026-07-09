import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createApprovalPolicy,
  nextPermissionMode,
  permissionModes
} from './permissionModes';
import { ToolGateway, ToolPermissionError } from './toolGateway';

describe('permissionModes', () => {
  it('cycles default -> classifier -> auto -> default', () => {
    expect(nextPermissionMode('default')).toBe('classifier');
    expect(nextPermissionMode('classifier')).toBe('auto');
    expect(nextPermissionMode('auto')).toBe('default');
    expect(permissionModes).toEqual(['default', 'classifier', 'auto']);
  });

  it('auto mode allows write tools without approval', async () => {
    const gateway = new ToolGateway({
      approvalPolicy: createApprovalPolicy('auto')
    });
    gateway.register({
      name: 'Write',
      description: '写文件',
      risk: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ input }) => ({ content: `wrote ${input.path}` })
    });

    const result = await gateway.call({
      runId: 'run-1',
      name: 'Write',
      input: { path: 'a.txt', content: 'hi' }
    });
    expect(result.status).toBe('completed');
  });

  it('classifier allows read/write and asks for bash', async () => {
    const gateway = new ToolGateway({
      approvalPolicy: createApprovalPolicy('classifier')
    });
    gateway.register({
      name: 'Read',
      description: '读文件',
      risk: 'read',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ input }) => ({ content: input.path })
    });
    gateway.register({
      name: 'Write',
      description: '写文件',
      risk: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ input }) => ({ content: `wrote ${input.path}` })
    });
    gateway.register({
      name: 'Bash',
      description: '执行命令',
      risk: 'execute',
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ input }) => ({ content: input.command })
    });

    await expect(
      gateway.call({ runId: 'r', name: 'Read', input: { path: 'a.ts' } })
    ).resolves.toMatchObject({ status: 'completed' });
    await expect(
      gateway.call({
        runId: 'r',
        name: 'Write',
        input: { path: 'a.ts', content: 'x' }
      })
    ).resolves.toMatchObject({ status: 'completed' });
    await expect(
      gateway.call({ runId: 'r', name: 'Bash', input: { command: 'ls' } })
    ).rejects.toBeInstanceOf(ToolPermissionError);
  });

  it('classifier denies dangerous bash commands', async () => {
    const gateway = new ToolGateway({
      approvalPolicy: createApprovalPolicy('classifier')
    });
    gateway.register({
      name: 'Bash',
      description: '执行命令',
      risk: 'execute',
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ input }) => ({ content: input.command })
    });

    await expect(
      gateway.call({
        runId: 'r',
        name: 'Bash',
        input: { command: 'sudo rm -rf /' }
      })
    ).rejects.toMatchObject({
      name: 'ToolPermissionError',
      reason: expect.stringContaining('dangerous')
    });
  });

  it('setApprovalPolicy switches gateway behavior at runtime', async () => {
    const gateway = new ToolGateway({
      approvalPolicy: createApprovalPolicy('default')
    });
    gateway.register({
      name: 'Write',
      description: '写文件',
      risk: 'write',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: async ({ input }) => ({ content: `wrote ${input.path}` })
    });

    await expect(
      gateway.call({
        runId: 'r',
        name: 'Write',
        input: { path: 'a.ts', content: 'x' }
      })
    ).rejects.toBeInstanceOf(ToolPermissionError);

    gateway.setApprovalPolicy(createApprovalPolicy('auto'));
    await expect(
      gateway.call({
        runId: 'r',
        name: 'Write',
        input: { path: 'a.ts', content: 'x' }
      })
    ).resolves.toMatchObject({ status: 'completed' });
  });
});
