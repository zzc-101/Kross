import { createAgentHost } from '../core/src/host/createAgentHost';
import type { AgentResult } from '../core/src/domain';
import type { AgentExecutionProfile } from '../core/src/runtime/agentExecutionProfile';
import type { AgentRunStreamEvent } from '../core/src/runtime/agentRuntimeTypes';

export interface AgentRuntimeHandle {
  runStreaming(input: {
    input: string;
    requestedMode: 'auto';
    signal?: AbortSignal;
  }): AsyncIterable<AgentRunStreamEvent>;
  resolveToolApprovalStreaming(input: {
    runId: string;
    approved: boolean;
    reason?: string;
    signal?: AbortSignal;
  }): AsyncIterable<AgentRunStreamEvent>;
}

export interface AgentHostHandle {
  runtime: AgentRuntimeHandle;
  close(): Promise<void>;
}

export async function createPersistentAgentHost(input: {
  workspaceRoot: string;
  env: Record<string, string | undefined>;
  executionProfile: AgentExecutionProfile;
}): Promise<AgentHostHandle> {
  const host = await createAgentHost({
    workspaceRoot: input.workspaceRoot,
    env: input.env,
    executionProfile: input.executionProfile
  });
  const runtime = host.createRuntime();
  runtime.setPermissionMode('classifier');
  return {
    runtime: runtime as unknown as AgentRuntimeHandle,
    close: () => host.close()
  };
}
