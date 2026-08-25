import { homedir } from 'node:os';
import { join } from 'node:path';

import { createSessionContext } from '../context/sessionContext';
import { createContextPolicy } from '../context/contextPolicy';
import { createLlmClientFromEnv } from '../llm/createLlmClient';
import type { LlmClient, LlmFetch } from '../llm/types';
import {
  connectReloadableMcpManager,
  type McpManager
} from '../mcp';
import type { AgentRuntimeOptions } from '../runtime/agentRuntimeTypes';
import type { SaasActiveSkill } from '../runtime/saasRuntimePolicy';
import { AgentRuntime } from '../runtime/agentRuntime';
import {
  createDefaultSubagentRunner,
  type SubagentRunDeps
} from '../runtime/subagentRunner';
import { TodoStore } from '../todo';
import { createSaasTools } from '../tools/builtin';
import { ToolGateway } from '../tools/toolGateway';
import { InMemoryTraceStore } from '../trace/inMemoryTraceStore';
import { ObservableTraceStore } from '../trace/observableTraceStore';
import { MutationCoordinator } from '../mutations/mutationService';
import {
  ExperimentalLifecycleHooks,
  type ExperimentalLifecycleHooksOptions
} from '../hooks/lifecycleHooks';

export interface CreateAgentHostConfigOptions {
  homeDir?: string;
  krossHome?: string;
}

export interface AgentHostTooling {
  toolGateway: ToolGateway;
  traceStore: ObservableTraceStore;
  todoStore: TodoStore;
  mutationCoordinator: MutationCoordinator;
  /** Keep the Task subagent model binding in sync with the active model. */
  setLlmClient: (client: LlmClient | undefined) => void;
  /** Shared subagent runner used by the Task tool. */
  runSubagent: NonNullable<AgentRuntimeOptions['runSubagent']>;
  mcpManager?: McpManager;
  closeTraceStore: () => void;
  close: () => Promise<void>;
}

export interface CreateAgentHostOptions {
  workspaceRoot: string;
  env?: Record<string, string | undefined>;
  fetch?: LlmFetch;
  config?: CreateAgentHostConfigOptions;
  runtimeOptions?: Partial<AgentRuntimeOptions>;
  /** Experimental, notification-only, redacted lifecycle extension. */
  experimentalLifecycleHooks?: ExperimentalLifecycleHooksOptions;
}

export interface AgentHost {
  tooling: AgentHostTooling;
  createRuntime(
    overrides?: Partial<AgentRuntimeOptions>
  ): AgentRuntime;
  close(): Promise<void>;
}

/**
 * Shared composition root for the containerized Worker runtime.
 *
 * The host owns Tooling resources and may create replacement Runtime instances
 * over the same gateway/session services. Callers still own foreground run
 * AbortControllers and must cancel them before awaiting close().
 */
export async function createAgentHost(
  options: CreateAgentHostOptions
): Promise<AgentHost> {
  const env = options.env ?? process.env;
  const config = options.config ?? {};
  const tooling = await bootstrapRuntimeTooling(
    options.workspaceRoot,
    env,
    config,
    options.fetch,
    options.runtimeOptions?.activeSkill
  );
  const lifecycleHooks = options.experimentalLifecycleHooks
    ? new ExperimentalLifecycleHooks(options.experimentalLifecycleHooks)
    : undefined;
  const unsubscribeLifecycleHooks = lifecycleHooks
    ? tooling.traceStore.subscribe((event) => lifecycleHooks.notify(event))
    : undefined;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        await tooling.close();
      } finally {
        unsubscribeLifecycleHooks?.();
        await lifecycleHooks?.close();
      }
    })();
    return closePromise;
  };
  return {
    tooling,
    createRuntime: (overrides = {}) => {
      if (closePromise) {
        throw new Error('AgentHost is closed');
      }
      return new AgentRuntime({
        ...createRuntimeOptionsFromEnv(
          options.workspaceRoot,
          env,
          options.fetch,
          config,
          tooling
        ),
        ...options.runtimeOptions,
        ...overrides
      });
    },
    close
  };
}

/**
 * Build AgentRuntime options (sync). Registers SaaS tools (+ Task + Todos).
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
    | 'mutationCoordinator'
  >
): AgentRuntimeOptions {
  const llmClient = createLlmClientFromEnv(env, fetch);
  const sessionContext = createSessionContext({
    client: llmClient,
    policy: createContextPolicy({
      contextWindow: llmClient?.contextWindow
    })
  });

  let toolGateway = tooling?.toolGateway;
  let traceStore = tooling?.traceStore;
  let todoStore = tooling?.todoStore;
  let runSubagent: AgentRuntimeOptions['runSubagent'] = tooling?.runSubagent;
  let mutationCoordinator = tooling?.mutationCoordinator;
  if (
    !toolGateway ||
    !traceStore ||
    !todoStore ||
    !runSubagent ||
    !mutationCoordinator
  ) {
    const created = createLocalTooling(cwd, llmClient, options);
    toolGateway = toolGateway ?? created.toolGateway;
    traceStore = traceStore ?? created.traceStore;
    todoStore = todoStore ?? created.todoStore;
    runSubagent = runSubagent ?? created.runSubagent;
    mutationCoordinator = mutationCoordinator ?? created.mutationCoordinator;
  } else {
    tooling?.setLlmClient?.(llmClient);
  }

  return {
    traceStore,
    toolGateway,
    todoStore,
    workspaceRoot: cwd,
    mutationCoordinator,
    maxToolIterations: parseMaxToolIterations(env),
    llmClient,
    onLlmClientChanged: tooling?.setLlmClient,
    sessionContext,
    subagentDepth: 0,
    runSubagent
  };
}

/**
 * One-shot tooling bootstrap: SaaS tools (Task + Todos) + MCP servers (stdio).
 * Reuse across runtime recreations so MCP, Task, and todo wiring stays stable.
 */
export async function bootstrapRuntimeTooling(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
  options: CreateAgentHostConfigOptions = {},
  fetch?: LlmFetch,
  activeSkill?: SaasActiveSkill
): Promise<AgentHostTooling> {
  const llmClient = createLlmClientFromEnv(env);
  const created = createLocalTooling(cwd, llmClient, options, activeSkill);
  const mcpManager = await connectReloadableMcpManager(created.toolGateway, {
    workspaceRoot: cwd,
    env,
    homeDir: options.homeDir,
    krossHome: options.krossHome,
    onWarning: (message) => {
      console.error(`[kross:mcp] ${message}`);
    }
  });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      created.closeTraceStore();
      await mcpManager.close();
    })();
    return closePromise;
  };

  return {
    toolGateway: created.toolGateway,
    traceStore: created.traceStore,
    todoStore: created.todoStore,
    mutationCoordinator: created.mutationCoordinator,
    setLlmClient: created.setLlmClient,
    runSubagent: created.runSubagent,
    mcpManager,
    closeTraceStore: created.closeTraceStore,
    close
  };
}

function createLocalTooling(
  cwd: string,
  initialLlmClient?: LlmClient,
  options: CreateAgentHostConfigOptions = {},
  activeSkill?: SaasActiveSkill
): {
  toolGateway: ToolGateway;
  traceStore: ObservableTraceStore;
  todoStore: TodoStore;
  mutationCoordinator: MutationCoordinator;
  setLlmClient: (client: LlmClient | undefined) => void;
  runSubagent: NonNullable<AgentRuntimeOptions['runSubagent']>;
  closeTraceStore: () => void;
} {
  const innerTraceStore = new InMemoryTraceStore();
  const traceStore = new ObservableTraceStore(innerTraceStore);
  const toolGateway = new ToolGateway({
    traceStore,
    defaultTimeoutMs: 120_000
  });
  const todoStore = new TodoStore();
  const mutationCoordinator = new MutationCoordinator(resolveKrossHome(options));

  const subagentDeps: SubagentRunDeps = {
    workspaceRoot: cwd,
    activeSkill,
    traceStore,
    llmClient: initialLlmClient,
    // worker 默认与主模型相同；后续可从 config 注入更便宜的 workerLlmClient
    workerLlmClient: initialLlmClient,
    maxDepth: 1,
    maxToolIterations: 40,
    getMutationService: (root) => mutationCoordinator.forWorkspace(root)
  };

  const runSubagent = createDefaultSubagentRunner(subagentDeps);

  for (const tool of createSaasTools(cwd, {
    includeTask: true,
    parentDepth: 0,
    runSubagent,
    todoStore,
    mutationService: mutationCoordinator.forWorkspace(cwd),
    mutationCoordinator
  })) {
    toolGateway.register(tool);
  }

  return {
    toolGateway,
    traceStore,
    todoStore,
    mutationCoordinator,
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

function resolveKrossHome(options: CreateAgentHostConfigOptions): string {
  return options.krossHome ?? join(options.homeDir ?? homedir(), '.kross');
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
