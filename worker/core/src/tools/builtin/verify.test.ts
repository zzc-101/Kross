import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { InMemoryTraceStore } from '../../runtime/agentRuntime.testSupport';
import { ToolGateway } from '../toolGateway';
import { createVerifyTool } from './verify';

describe('Verify tool', () => {
  it('runs a recognized verification command without a shell', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kross-verify-'));
    try {
      writeFileSync(
        join(workspace, 'package.json'),
        JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } })
      );
      const traceStore = new InMemoryTraceStore();
      const gateway = new ToolGateway({
        traceStore,
        approvalPolicy: () => ({ action: 'allow' })
      });
      gateway.register(createVerifyTool(workspace));

      const result = await gateway.call({
        runId: 'verify-run',
        name: 'Verify',
        input: { command: 'npm test' }
      });

      expect(result).toMatchObject({
        status: 'completed',
        data: expect.objectContaining({ exitCode: 0 })
      });
      expect(
        traceStore.events.find(
          (event) => event.type === 'tool_call.started'
        )?.payload.input
      ).toMatchObject({ verificationCommand: 'npm test' });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.each([
    'npm test && rm -rf build',
    'npm test | tee output.log',
    'npm test > output.log',
    'echo npm test'
  ])('rejects unsafe or non-verification command: %s', async (command) => {
    const workspace = mkdtempSync(join(tmpdir(), 'kross-verify-reject-'));
    try {
      const gateway = new ToolGateway({
        approvalPolicy: () => ({ action: 'allow' })
      });
      gateway.register(createVerifyTool(workspace));

      await expect(
        gateway.call({
          runId: 'verify-reject',
          name: 'Verify',
          input: { command }
        })
      ).rejects.toThrow(/Verify|验证/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
