import { createAgentHost, type AgentExecutionProfile, type AgentResult, type AgentRunInput, type AgentRunStreamEvent } from '@kross/core';
import type { RunSpec } from '@kross/protocol';

export interface WorkAgentRuntime {
  runStreaming(input: AgentRunInput): AsyncIterable<AgentRunStreamEvent>;
  resolveToolApproval(input: { runId: string; approved: boolean; reason?: string; signal?: AbortSignal }): Promise<AgentResult>;
  exportContextState(): unknown;
  exportWorkState(): unknown;
  restoreContextState(state: never): boolean;
  restoreWorkState(state: never): boolean;
}

export interface WorkRuntimeHandle { runtime: WorkAgentRuntime; close(): Promise<void> }
export interface WorkRuntimeFactory {
  create(input: { runSpec: RunSpec; workspaceRoot: string; executionProfile: AgentExecutionProfile }): Promise<WorkRuntimeHandle>;
}
export interface ModelEnvironmentResolver {
  resolve(input: { credentialHandle: string; runSpec: RunSpec }): Promise<Record<string, string | undefined>>;
}

/** Production composition: model secrets are resolved from a run-scoped handle. */
export function createCoreWorkRuntimeFactory(input: { modelEnvironmentResolver: ModelEnvironmentResolver }): WorkRuntimeFactory {
  return {
    async create({ runSpec, workspaceRoot, executionProfile }) {
      const env = await input.modelEnvironmentResolver.resolve({ credentialHandle: runSpec.model.credentialHandle, runSpec });
      const host = await createAgentHost({ workspaceRoot, env, executionProfile });
      const runtime = host.createRuntime();
      return { runtime: runtime as unknown as WorkAgentRuntime, close: () => host.close() };
    }
  };
}
