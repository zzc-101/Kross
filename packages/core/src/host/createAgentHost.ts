import { homedir } from 'node:os';
import { join } from 'node:path';

import { createSessionContext } from '../context/sessionContext';
import { createContextPolicy } from '../context/contextPolicy';
import {
  createLlmClientFromKrossConfig,
  loadKrossConfig
} from '../config/configImport';
import type { ProjectRegistry } from '../domain';
import { createLlmClientFromEnv } from '../llm/createLlmClient';
import type { LlmClient, LlmFetch } from '../llm/types';
import {
  connectAndRegisterMcpTools,
  type McpManager
} from '../mcp';
import type { AgentRuntimeOptions } from '../runtime/agentRuntimeTypes';
import {
  createDefaultSubagentRunner,
  type SubagentRunDeps
} from '../runtime/subagentRunner';
import { TodoStore } from '../todo';
import { createBuiltinTools } from '../tools/builtin';
import { ToolGateway } from '../tools/toolGateway';
import { ObservableTraceStore } from '../trace/observableTraceStore';
import { SessionTraceStore } from '../trace/sessionTraceStore';
import {
  collectAllowedWorkspaceRoots,
  loadProjectRegistry,
  selectActiveProject
} from '../workspace/projectRegistry';
import { WorkspaceRoots } from '../workspace/workspaceRoots';
import { SkillRegistry } from '../skills/skillRegistry';

export interface CreateAgentHostConfigOptions {
  homeDir?: string;
  krossHome?: string;
}

export interface AgentHostTooling {
  toolGateway: ToolGateway;
  traceStore: ObservableTraceStore;
  todoStore: TodoStore;
  workspaceRoots: WorkspaceRoots;
  skillRegistry: SkillRegistry;
  /** Update LLM used by Task subagents (e.g. after /import). */
  setLlmClient: (client: LlmClient | undefined) => void;
  /** Shared subagent runner (multi-root Task + conductor fan-out). */
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
  options: CreateAgentHostConfigOptions = {},
  tooling?: Pick<
    AgentHostTooling,
    | 'toolGateway'
    | 'traceStore'
    | 'todoStore'
    | 'setLlmClient'
    | 'runSubagent'
    | 'workspaceRoots'
    | 'skillRegistry'
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
  let workspaceRoots = tooling?.workspaceRoots;
  let skillRegistry = tooling?.skillRegistry;
  if (
    !toolGateway ||
    !traceStore ||
    !todoStore ||
    !runSubagent ||
    !workspaceRoots ||
    !skillRegistry
  ) {
    const created = createLocalTooling(cwd, llmClient, options, projectRegistry);
    toolGateway = toolGateway ?? created.toolGateway;
    traceStore = traceStore ?? created.traceStore;
    todoStore = todoStore ?? created.todoStore;
    runSubagent = runSubagent ?? created.runSubagent;
    workspaceRoots = workspaceRoots ?? created.workspaceRoots;
    skillRegistry = skillRegistry ?? created.skillRegistry;
  } else {
    tooling?.setLlmClient?.(llmClient);
  }

  // Seed workspace roots from registry paths (if not already added)
  if (projectRegistry && workspaceRoots) {
    for (const project of Object.values(projectRegistry.projects)) {
      for (const repo of project.repos) {
        try {
          if (repo.path !== cwd) {
            workspaceRoots.add(repo.path, repo.id);
          }
        } catch {
          // ignore missing paths at startup
        }
      }
    }
  }

  return {
    traceStore,
    toolGateway,
    todoStore,
    workspaceRoot: cwd,
    workspaceRoots,
    skillRegistry,
    personalSkillsDir: resolvePersonalSkillsDir(options),
    maxToolIterations: parseMaxToolIterations(env),
    llmClient,
    sessionContext,
    subagentDepth: 0,
    projectRegistry,
    projectRegistryPath,
    activeProjectId: activeSelection?.projectId,
    runSubagent,
    workerLlmClient: llmClient
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
  options: CreateAgentHostConfigOptions = {}
): Promise<AgentHostTooling> {
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
    workspaceRoots: created.workspaceRoots,
    skillRegistry: created.skillRegistry,
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
  options: CreateAgentHostConfigOptions = {},
  projectRegistry?: ProjectRegistry
): {
  toolGateway: ToolGateway;
  traceStore: ObservableTraceStore;
  todoStore: TodoStore;
  workspaceRoots: WorkspaceRoots;
  skillRegistry: SkillRegistry;
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
  const workspaceRoots = new WorkspaceRoots(cwd);
  const skillRegistry = new SkillRegistry({
    getRoots: () => workspaceRoots.list(),
    personalSkillsDir: resolvePersonalSkillsDir(options)
  });

  const subagentDeps: SubagentRunDeps = {
    workspaceRoot: cwd,
    getAllowedWorkspaceRoots: () => {
      const fromRoots = workspaceRoots.allowedRoots();
      const fromRegistry = collectAllowedWorkspaceRoots(projectRegistry, cwd);
      return [...new Set([...fromRoots, ...fromRegistry])];
    },
    traceStore,
    llmClient: initialLlmClient,
    // worker 默认与主模型相同；后续可从 config 注入更便宜的 workerLlmClient
    workerLlmClient: initialLlmClient,
    maxDepth: 1,
    maxToolIterations: 40,
    personalSkillsDir: resolvePersonalSkillsDir(options)
  };

  const runSubagent = createDefaultSubagentRunner(subagentDeps);

  const resolveRepoPath = (repoId: string): string | undefined => {
    const fromRoots = workspaceRoots.resolveById(repoId);
    if (fromRoots) {
      return fromRoots;
    }
    if (!projectRegistry) {
      return undefined;
    }
    for (const project of Object.values(projectRegistry.projects)) {
      const repo = project.repos.find((item) => item.id === repoId);
      if (repo) {
        return repo.path;
      }
    }
    return undefined;
  };

  for (const tool of createBuiltinTools(cwd, {
    includeTask: true,
    parentDepth: 0,
    runSubagent,
    resolveRepoPath,
    todoStore,
    skillRegistry
  })) {
    toolGateway.register(tool);
  }

  return {
    toolGateway,
    traceStore,
    todoStore,
    workspaceRoots,
    skillRegistry,
    runSubagent,
    setLlmClient: (client) => {
      subagentDeps.llmClient = client;
      subagentDeps.workerLlmClient = client;
    },
    closeTraceStore: () => {
      innerTraceStore.close();
    }
  };
}

function resolvePersonalSkillsDir(options: CreateAgentHostConfigOptions): string {
  const krossHome =
    options.krossHome ?? join(options.homeDir ?? homedir(), '.kross');
  return join(krossHome, 'skills');
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
