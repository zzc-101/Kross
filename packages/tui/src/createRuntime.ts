import { join } from 'node:path';

import {
  createLlmClientFromEnv,
  JsonlTraceStore,
  type AgentRuntimeOptions,
  type LlmFetch
} from '@kross/core';

export function createRuntimeOptionsFromEnv(
  cwd: string,
  env: Record<string, string | undefined>,
  fetch?: LlmFetch
): AgentRuntimeOptions {
  return {
    traceStore: new JsonlTraceStore(join(cwd, 'runs')),
    llmClient: createLlmClientFromEnv(env, fetch)
  };
}
