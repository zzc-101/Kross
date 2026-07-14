import { join } from 'node:path';

import {
  connectAndRegisterMcpTools,
  createBuiltinTools,
  createLlmClientFromKrossConfig,
  createLlmClientFromEnv,
  JsonlTraceStore,
  loadKrossConfig,
  ObservableTraceStore,
  ToolGateway,
  type AgentRuntimeOptions,
  type LlmFetch,
  type McpManager
} from '@kross/core';

export interface CreateRuntimeConfigOptions {
  homeDir?: string;
  krossHome?: string;
}

export interface RuntimeTooling {
  toolGateway: ToolGateway;
  traceStore: ObservableTraceStore;
  mcpManager?: McpManager;
  close: () => Promise<void>;
}

/**
 * Build AgentRuntime options (sync). Registers builtin tools only.
 * For MCP, prefer `bootstrapRuntimeTooling` once at process start and pass
 * the shared gateway/trace into options.
 */
export function createRuntimeOptionsFromEnv(
  cwd: string,
  env: Record<string, string | undefined>,
  fetch?: LlmFetch,
  options: CreateRuntimeConfigOptions = {},
  tooling?: Pick<RuntimeTooling, 'toolGateway' | 'traceStore'>
): AgentRuntimeOptions {
  const savedConfig = loadKrossConfig(options);
  const envClient = createLlmClientFromEnv(
    env,
    fetch,
    savedConfig?.llm?.contextWindow
  );

  let toolGateway = tooling?.toolGateway;
  let traceStore = tooling?.traceStore;
  if (!toolGateway || !traceStore) {
    const created = createLocalTooling(cwd);
    toolGateway = created.toolGateway;
    traceStore = created.traceStore;
  }

  return {
    traceStore,
    toolGateway,
    workspaceRoot: cwd,
    maxToolIterations: parseMaxToolIterations(env),
    llmClient:
      envClient ??
      createLlmClientFromKrossConfig(savedConfig, fetch)
  };
}

/**
 * One-shot tooling bootstrap: builtins + MCP servers (stdio).
 * Reuse across runtime recreations so MCP connections survive /import refresh.
 */
export async function bootstrapRuntimeTooling(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  options: CreateRuntimeConfigOptions = {}
): Promise<RuntimeTooling> {
  const created = createLocalTooling(cwd);
  const warnings: string[] = [];
  const mcpManager = await connectAndRegisterMcpTools(created.toolGateway, {
    workspaceRoot: cwd,
    env,
    homeDir: options.homeDir,
    krossHome: options.krossHome,
    onWarning: (message) => {
      warnings.push(message);
      console.error(`[kross:mcp] ${message}`);
    }
  });

  return {
    toolGateway: created.toolGateway,
    traceStore: created.traceStore,
    mcpManager,
    close: async () => {
      await mcpManager.close();
    }
  };
}

function createLocalTooling(cwd: string): {
  toolGateway: ToolGateway;
  traceStore: ObservableTraceStore;
} {
  const traceStore = new ObservableTraceStore(
    new JsonlTraceStore(join(cwd, 'runs'))
  );
  const toolGateway = new ToolGateway({
    traceStore,
    defaultTimeoutMs: 120_000
  });
  for (const tool of createBuiltinTools(cwd)) {
    toolGateway.register(tool);
  }
  return { toolGateway, traceStore };
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
