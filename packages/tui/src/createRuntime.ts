import { join } from 'node:path';

import {
  createLlmClientFromKrossConfig,
  createLlmClientFromEnv,
  JsonlTraceStore,
  loadKrossConfig,
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

  return {
    traceStore: new JsonlTraceStore(join(cwd, 'runs')),
    llmClient:
      envClient ??
      createLlmClientFromKrossConfig(loadKrossConfig(options), fetch)
  };
}
