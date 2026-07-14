import { join } from 'node:path';

import {
  connectAndRegisterMcpTools,
  createBuiltinTools,
  createDefaultSubagentRunner,
  createLlmClientFromKrossConfig,
  createLlmClientFromEnv,
  JsonlTraceStore,
  loadKrossConfig,
  ObservableTraceStore,
  ToolGateway,
  type AgentRuntimeOptions,
  type LlmClient,
  type LlmFetch,
  type McpManager,
  type SubagentRunDeps
} from '@kross/core';

export interface CreateRuntimeConfigOptions {
  homeDir?: string;
  krossHome?: string;
}

export interface RuntimeTooling {
  toolGateway: ToolGateway;
  traceStore: ObservableTraceStore;
  /** Update LLM used by Task subagents (e.g. after /import). */
  setLlmClient: (client: LlmClient | undefined) => void;
  mcpManager?: McpManager;
  close: () => Promise<void>;
}

/**
 * Build AgentRuntime options (sync). Registers builtin tools (+ Task).
 * For MCP, prefer `bootstrapRuntimeTooling` once at process start and pass
 * the shared gateway/trace into options.
 */
export function createRuntimeOptionsFromEnv(
  cwd: string,
  env: Record<string, string | undefined>,
  fetch?: LlmFetch,
  options: CreateRuntimeConfigOptions = {},
  tooling?: Pick<RuntimeTooling, 'toolGateway' | 'traceStore' | 'setLlmClient'>
): AgentRuntimeOptions {
  const savedConfig = loadKrossConfig(options);
  const envClient = createLlmClientFromEnv(
    env,
    fetch,
    savedConfig?.llm?.contextWindow
  );
  const llmClient =
    envClient ?? createLlmClientFromKrossConfig(savedConfig, fetch);

  let toolGateway = tooling?.toolGateway;
  let traceStore = tooling?.traceStore;
  if (!toolGateway || !traceStore) {
    const created = createLocalTooling(cwd, llmClient);
    toolGateway = created.toolGateway;
    traceStore = created.traceStore;
  } else {
    tooling.setLlmClient?.(llmClient);
  }

  return {
    traceStore,
    toolGateway,
    workspaceRoot: cwd,
    maxToolIterations: parseMaxToolIterations(env),
    llmClient,
    subagentDepth: 0
  };
}

/**
 * One-shot tooling bootstrap: builtins (incl. Task) + MCP servers (stdio).
 * Reuse across runtime recreations so MCP/Task wiring survives /import refresh.
 */
export async function bootstrapRuntimeTooling(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  options: CreateRuntimeConfigOptions = {}
): Promise<RuntimeTooling> {
  const savedConfig = loadKrossConfig(options);
  const llmClient =
    createLlmClientFromEnv(env, undefined, savedConfig?.llm?.contextWindow) ??
    createLlmClientFromKrossConfig(savedConfig);
  const created = createLocalTooling(cwd, llmClient);
  const mcpManager = await connectAndRegisterMcpTools(created.toolGateway, {
    workspaceRoot: cwd,
    env,
    homeDir: options.homeDir,
    krossHome: options.krossHome,
    onWarning: (message) => {
      console.error(`[kross:mcp] ${message}`);
    }
  });

  return {
    toolGateway: created.toolGateway,
    traceStore: created.traceStore,
    setLlmClient: created.setLlmClient,
    mcpManager,
    close: async () => {
      await mcpManager.close();
    }
  };
}

function createLocalTooling(
  cwd: string,
  initialLlmClient?: LlmClient
): {
  toolGateway: ToolGateway;
  traceStore: ObservableTraceStore;
  setLlmClient: (client: LlmClient | undefined) => void;
} {
  const traceStore = new ObservableTraceStore(
    new JsonlTraceStore(join(cwd, 'runs'))
  );
  const toolGateway = new ToolGateway({
    traceStore,
    defaultTimeoutMs: 120_000
  });

  const subagentDeps: SubagentRunDeps = {
    workspaceRoot: cwd,
    traceStore,
    llmClient: initialLlmClient,
    maxDepth: 1,
    maxToolIterations: 40
  };

  for (const tool of createBuiltinTools(cwd, {
    includeTask: true,
    parentDepth: 0,
    runSubagent: createDefaultSubagentRunner(subagentDeps)
  })) {
    toolGateway.register(tool);
  }

  return {
    toolGateway,
    traceStore,
    setLlmClient: (client) => {
      subagentDeps.llmClient = client;
    }
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
