import { join } from 'node:path';

import {
  createBuiltinTools,
  createLlmClientFromKrossConfig,
  createLlmClientFromEnv,
  JsonlTraceStore,
  loadKrossConfig,
  ToolGateway,
  type AgentRuntimeOptions,
  type LlmFetch
} from '@kross/core';

export interface CreateRuntimeConfigOptions {
  homeDir?: string;
  krossHome?: string;
}

export function createRuntimeOptionsFromEnv(
  cwd: string,
  env: Record<string, string | undefined>,
  fetch?: LlmFetch,
  options: CreateRuntimeConfigOptions = {}
): AgentRuntimeOptions {
  const envClient = createLlmClientFromEnv(env, fetch);
  const traceStore = new JsonlTraceStore(join(cwd, 'runs'));

  const toolGateway = new ToolGateway({ traceStore, defaultTimeoutMs: 120_000 });
  for (const tool of createBuiltinTools(cwd)) {
    toolGateway.register(tool);
  }

  return {
    traceStore,
    toolGateway,
    llmClient:
      envClient ??
      createLlmClientFromKrossConfig(loadKrossConfig(options), fetch)
  };
}
