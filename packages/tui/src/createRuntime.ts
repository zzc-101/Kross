import { join } from 'node:path';

import {
  createBuiltinTools,
  createLlmClientFromKrossConfig,
  createLlmClientFromEnv,
  JsonlTraceStore,
  loadKrossConfig,
  ObservableTraceStore,
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
  const traceStore = new ObservableTraceStore(new JsonlTraceStore(join(cwd, 'runs')));

  const toolGateway = new ToolGateway({ traceStore, defaultTimeoutMs: 120_000 });
  for (const tool of createBuiltinTools(cwd)) {
    toolGateway.register(tool);
  }

  return {
    traceStore,
    toolGateway,
    workspaceRoot: cwd,
    maxToolIterations: parseMaxToolIterations(env),
    llmClient:
      envClient ??
      createLlmClientFromKrossConfig(loadKrossConfig(options), fetch)
  };
}

/** AGENT_MAX_TOOL_ITERATIONS：正整数则采用，否则走 Runtime 默认（200，触顶软着陆）。 */
function parseMaxToolIterations(
  env: Record<string, string | undefined>
): number | undefined {
  const raw = env.AGENT_MAX_TOOL_ITERATIONS?.trim();
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    return undefined;
  }
  return Math.floor(value);
}
