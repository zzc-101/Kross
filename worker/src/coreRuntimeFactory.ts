import { createAgentHost, type AgentExecutionProfile, type AgentResult } from '@kross/core';

export interface AgentRuntimeHandle {
  runStreaming(input: { input: string; requestedMode: 'auto'; signal?: AbortSignal }): AsyncIterable<{
    type: string;
    text?: string;
    result?: AgentResult;
  }>;
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
  return {
    runtime: host.createRuntime() as unknown as AgentRuntimeHandle,
    close: () => host.close()
  };
}
