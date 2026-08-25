import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createAgentHost } from '../core/src/host/createAgentHost';
import type { ContextSource } from '../core/src/context/sessionContext';
import type { SaasActiveSkill } from '../core/src/runtime/saasRuntimePolicy';
import type { AgentRunStreamEvent } from '../core/src/runtime/agentRuntimeTypes';

export interface AgentRuntimeHandle {
  restoreConversation(messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>): unknown;
  runStreaming(input: {
    input: string;
    signal?: AbortSignal;
  }): AsyncIterable<AgentRunStreamEvent>;
  resolveToolApprovalStreaming(input: {
    runId: string;
    approved: boolean;
    reason?: string;
    signal?: AbortSignal;
  }): AsyncIterable<AgentRunStreamEvent>;
  getRunUsage(runId: string): Promise<{
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    estimatedCostUsd: number;
    durationMs: number;
  } | undefined>;
  getContextUsage(): {
    usedTokens: number;
    contextWindow: number;
    headerRatio: number;
  };
}

export interface AgentHostHandle {
  runtime: AgentRuntimeHandle;
  close(): Promise<void>;
}

export async function createPersistentAgentHost(input: {
  workspaceRoot: string;
  env: Record<string, string | undefined>;
  activeSkill?: SaasActiveSkill;
  memoryContextSources: ContextSource[];
}): Promise<AgentHostHandle> {
  const krossHome = join(input.workspaceRoot, '.kross');
  await mkdir(krossHome, { recursive: true });
  const host = await createAgentHost({
    workspaceRoot: input.workspaceRoot,
    env: input.env,
    config: { homeDir: input.workspaceRoot, krossHome },
    runtimeOptions: {
      ...(input.activeSkill ? { activeSkill: input.activeSkill } : {}),
      memoryContextSources: input.memoryContextSources
    }
  });
  const runtime = host.createRuntime();
  return {
    runtime: runtime as unknown as AgentRuntimeHandle,
    close: () => host.close()
  };
}
