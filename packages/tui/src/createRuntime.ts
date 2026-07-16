import {
  collectAllowedWorkspaceRoots,
  connectAndRegisterMcpTools,
  createBuiltinTools,
  createDefaultSubagentRunner,
  createLlmClientFromKrossConfig,
  createLlmClientFromEnv,
  createContextPolicy,
  createSessionContext,
  loadKrossConfig,
  loadProjectRegistry,
  ObservableTraceStore,
  selectActiveProject,
  SessionTraceStore,
  TodoStore,
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
  todoStore: TodoStore;
  /** Update LLM used by Task subagents (e.g. after /import). */
  setLlmClient: (client: LlmClient | undefined) => void;
  /** Shared subagent runner (multi-root Task + cross-repo fan-out). */
  runSubagent: NonNullable<AgentRuntimeOptions['runSubagent']>;
  mcpManager?: McpManager;
  closeTraceStore: () => void;
  close: () => Promise<void>;
}

/**
 * Build AgentRuntime options (sync). Registers builtin tools (+ Task + Todos).
 * For MCP, prefer `bootstrapRuntimeTooling` once at process start and pass
 * the shared gateway/trace into options.
 */
export function createRuntimeOptionsFromEnv(
  cwd: string,
  env: Record<string, string | undefined>,
  fetch?: LlmFetch,
  options: CreateRuntimeConfigOptions = {},
  tooling?: Pick<
    RuntimeTooling,
    'toolGateway' | 'traceStore' | 'todoStore' | 'setLlmClient' | 'runSubagent'
  >
): AgentRuntimeOptions {
  const savedConfig = loadKrossConfig(options);
  const envClient = createLlmClientFromEnv(
    env,
    fetch,
    savedConfig?.llm?.contextWindow
  );
  const llmClient =
    envClient ?? createLlmClientFromKrossConfig(savedConfig, fetch);
  const summarizerClient = savedConfig?.context?.summarizer
    ? createLlmClientFromKrossConfig(
        { llm: savedConfig.context.summarizer },
        fetch
      )
    : undefined;
  const sessionContext = createSessionContext({
    client: llmClient,
    summarizerClient,
    compactionInstructions: savedConfig?.context?.compactionInstructions,
    policy: createContextPolicy({
      contextWindow: llmClient?.contextWindow,
      preserveFullTurns: nonNegativeInteger(
        savedConfig?.context?.preserveFullTurns
      ),
      preserveRecentTokens: positiveInteger(
        savedConfig?.context?.preserveRecentTokens
      )
    })
  });

  const loadedRegistry = loadProjectRegistry({
    homeDir: options.homeDir,
    krossHome: options.krossHome,
    workspaceRoot: cwd
  });
  const projectRegistry = loadedRegistry?.registry;
  const projectRegistryPath = loadedRegistry?.sourcePath;
  const activeSelection = projectRegistry
    ? selectActiveProject(projectRegistry, { workspaceRoot: cwd })
    : undefined;

  let toolGateway = tooling?.toolGateway;
  let traceStore = tooling?.traceStore;
  let todoStore = tooling?.todoStore;
  let runSubagent: AgentRuntimeOptions['runSubagent'] = tooling?.runSubagent;
  if (!toolGateway || !traceStore || !todoStore || !runSubagent) {
    const created = createLocalTooling(cwd, llmClient, options, projectRegistry);
    toolGateway = toolGateway ?? created.toolGateway;
    traceStore = traceStore ?? created.traceStore;
    todoStore = todoStore ?? created.todoStore;
    runSubagent = runSubagent ?? created.runSubagent;
  } else {
    tooling?.setLlmClient?.(llmClient);
  }

  return {
    traceStore,
    toolGateway,
    todoStore,
    workspaceRoot: cwd,
    maxToolIterations: parseMaxToolIterations(env),
    llmClient,
    sessionContext,
    subagentDepth: 0,
    projectRegistry,
    projectRegistryPath,
    activeProjectId: activeSelection?.projectId,
    runSubagent
  };
}

function positiveInteger(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value !== undefined && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * One-shot tooling bootstrap: builtins (Task + Todos) + MCP servers (stdio).
 * Reuse across runtime recreations so MCP/Task/todo wiring survives /import.
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
  const loadedRegistry = loadProjectRegistry({
    homeDir: options.homeDir,
    krossHome: options.krossHome,
    workspaceRoot: cwd
  });
  const created = createLocalTooling(
    cwd,
    llmClient,
    options,
    loadedRegistry?.registry
  );
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
    todoStore: created.todoStore,
    setLlmClient: created.setLlmClient,
    runSubagent: created.runSubagent,
    mcpManager,
    closeTraceStore: created.closeTraceStore,
    close: async () => {
      created.closeTraceStore();
      await mcpManager.close();
    }
  };
}

function createLocalTooling(
  cwd: string,
  initialLlmClient?: LlmClient,
  options: CreateRuntimeConfigOptions = {},
  projectRegistry?: import('@kross/core').ProjectRegistry
): {
  toolGateway: ToolGateway;
  traceStore: ObservableTraceStore;
  todoStore: TodoStore;
  setLlmClient: (client: LlmClient | undefined) => void;
  runSubagent: NonNullable<AgentRuntimeOptions['runSubagent']>;
  closeTraceStore: () => void;
} {
  const innerTraceStore = new SessionTraceStore({
    workspacePath: cwd,
    krossHome: options.krossHome
  });
  const traceStore = new ObservableTraceStore(innerTraceStore);
  const toolGateway = new ToolGateway({
    traceStore,
    defaultTimeoutMs: 120_000
  });
  const todoStore = new TodoStore();

  const allowedWorkspaceRoots = collectAllowedWorkspaceRoots(
    projectRegistry,
    cwd
  );

  const subagentDeps: SubagentRunDeps = {
    workspaceRoot: cwd,
    allowedWorkspaceRoots,
    traceStore,
    llmClient: initialLlmClient,
    maxDepth: 1,
    maxToolIterations: 40
  };

  const runSubagent = createDefaultSubagentRunner(subagentDeps);

  const resolveRepoPath = projectRegistry
    ? (repoId: string): string | undefined => {
        for (const project of Object.values(projectRegistry.projects)) {
          const repo = project.repos.find((item) => item.id === repoId);
          if (repo) {
            return repo.path;
          }
        }
        return undefined;
      }
    : undefined;

  for (const tool of createBuiltinTools(cwd, {
    includeTask: true,
    parentDepth: 0,
    runSubagent,
    resolveRepoPath,
    todoStore
  })) {
    toolGateway.register(tool);
  }

  return {
    toolGateway,
    traceStore,
    todoStore,
    runSubagent,
    setLlmClient: (client) => {
      subagentDeps.llmClient = client;
    },
    closeTraceStore: () => {
      innerTraceStore.close();
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
