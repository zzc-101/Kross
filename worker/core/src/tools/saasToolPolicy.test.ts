import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { saasToolApprovalPolicy } from './saasToolPolicy';
import { ToolGateway } from './toolGateway';

describe('saasToolApprovalPolicy', () => {
  it('allows workspace reads and writes', () => {
    expect(decision('Read', 'read', {})).toMatchObject({ action: 'allow' });
    expect(decision('Write', 'write', {})).toMatchObject({ action: 'allow' });
  });

  it('asks only before external or unknown operations', () => {
    const gateway = new ToolGateway({ approvalPolicy: saasToolApprovalPolicy });
    gateway.register({
      name: 'RemoteAction',
      description: 'modify remote data',
      risk: 'network',
      category: 'mcp:remote',
      inputSchema: z.object({}),
      execute: async () => ({ content: 'done' })
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
