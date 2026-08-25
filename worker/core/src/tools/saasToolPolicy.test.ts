import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createGitTool } from './builtin/git';
import { saasToolApprovalPolicy } from './saasToolPolicy';
import { ToolGateway } from './toolGateway';

describe('saasToolApprovalPolicy', () => {
  it('allows local reads, writes and routine container commands', () => {
    expect(decision('Read', 'read', {})).toMatchObject({ action: 'allow' });
    expect(decision('Write', 'write', {})).toMatchObject({ action: 'allow' });
    expect(decision('Bash', 'execute', { command: 'pnpm test' })).toMatchObject({
      action: 'allow'
    });
  });

  it('denies destructive shell commands instead of asking the user', () => {
    expect(decision('Bash', 'execute', { command: 'sudo rm -rf /' })).toMatchObject({
      action: 'deny',
      reason: expect.stringContaining('自动阻止')
    });
  });

  it('asks only before external or unknown operations', () => {
    const gateway = new ToolGateway({ approvalPolicy: saasToolApprovalPolicy });
    gateway.register(createGitTool('/tmp'));
    gateway.register({
      name: 'RemoteAction',
      description: 'modify remote data',
      risk: 'network',
      category: 'mcp:remote',
      inputSchema: z.object({}),
      execute: async () => ({ content: 'done' })
    });

    expect(gateway.inspectCall('Git', { action: 'fetch' }).approval).toMatchObject({
      action: 'allow'
    });
    expect(gateway.inspectCall('Git', { action: 'push' }).approval).toMatchObject({
      action: 'ask'
    });
    expect(gateway.inspectCall('RemoteAction', {}).approval).toMatchObject({
      action: 'ask'
    });
  });
});

function decision(name: string, risk: 'read' | 'write' | 'execute' | 'network', input: unknown) {
  return saasToolApprovalPolicy({
    tool: { name, description: name, risk },
    input
  });
}
