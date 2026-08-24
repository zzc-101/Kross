import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createAgentHost } from '../core/src/host/createAgentHost';
import type { AgentMode } from '../core/src/domain';
import type { AgentExecutionProfile } from '../core/src/runtime/agentExecutionProfile';
import type { AgentRunStreamEvent } from '../core/src/runtime/agentRuntimeTypes';

interface RunTraceDetail {
  llmStats: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    estimatedCostUsd: number;
    durationMs: number;
  };
}

export interface AgentRuntimeHandle {
  restoreConversation(messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>): unknown;
  runStreaming(input: {
    input: string;
    requestedMode: AgentMode;
    signal?: AbortSignal;
  }): AsyncIterable<AgentRunStreamEvent>;
  resolveToolApprovalStreaming(input: {
    runId: string;
    approved: boolean;
    reason?: string;
    signal?: AbortSignal;
  }): AsyncIterable<AgentRunStreamEvent>;
  inspectTrace(runId: string): Promise<RunTraceDetail | null>;
  getContextUsage(input: { requestedMode: AgentMode; currentUserInput?: string }): {
    usedTokens: number;
    contextWindow: number;
    headerRatio: number;
  };
}

export interface AgentHostHandle {
  runtime: AgentRuntimeHandle;
  reloadMcp(): Promise<void>;
  close(): Promise<void>;
}

export async function createPersistentAgentHost(input: {
  workspaceRoot: string;
  env: Record<string, string | undefined>;
  executionProfile: AgentExecutionProfile;
}): Promise<AgentHostHandle> {
  const krossHome = join(input.workspaceRoot, '.kross');
  await mkdir(krossHome, { recursive: true });
  const host = await createAgentHost({
    workspaceRoot: input.workspaceRoot,
    env: input.env,
    executionProfile: input.executionProfile,
    config: { homeDir: input.workspaceRoot, krossHome },
    runtimeOptions: { personalSkillsDir: join(input.workspaceRoot, 'skills') }
  });
  const runtime = host.createRuntime();
  runtime.setPermissionMode('classifier');
  return {
    runtime: runtime as unknown as AgentRuntimeHandle,
    reloadMcp: async () => {
      await host.tooling.mcpManager?.reload?.();
    },
    close: () => host.close()
  };
}
