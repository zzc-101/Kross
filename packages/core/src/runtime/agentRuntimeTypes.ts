import type { ContextSnapshot, SessionContext } from '../context/sessionContext';
import type {
  AgentMode,
  AgentResult,
  ConductorPlan,
  ImpactMap,
  ProjectRegistry,
  TraceEvent
} from '../domain';
import type { LlmClient } from '../llm/types';
import type { TodoStore } from '../todo/todoStore';
import type { ToolGateway } from '../tools/toolGateway';
import type { TraceStore } from '../trace/traceStore';
import type { GitRunner } from '../workspace/workspaceDiff';
import type {
  SubagentRunOutcome,
  SubagentRunRequest
} from './subagentRunner';
import type { WorkspaceRoots } from '../workspace/workspaceRoots';

export interface AgentRuntimeOptions {
  traceStore: TraceStore;
  llmClient?: LlmClient;
  sessionContext?: SessionContext;
  /** @deprecated 使用 sessionContext */
  contextManager?: SessionContext;
  toolGateway?: ToolGateway;
  maxToolIterations?: number;
  createRunId?: () => string;
  now?: () => Date;
  workspaceRoot?: string;
  runGit?: GitRunner;
  /**
   * Nesting depth for subagent runs (0 = main agent).
   * Used by Task tool to forbid nested spawn when depth >= 1.
   */
  subagentDepth?: number;
  /** Session todo list shared with TodoWrite/TodoRead tools. */
  todoStore?: TodoStore;
  /**
   * Session multi-directory roots (/add-dir). When set, conductor impact and
   * Task allowlist prefer these over (or in addition to) project registry.
   */
  workspaceRoots?: WorkspaceRoots;
  /** Loaded ~/.kross/projects.json (and optional workspace overlay). */
  projectRegistry?: ProjectRegistry;
  /** Absolute path of the registry file (for prompts / errors). */
  projectRegistryPath?: string;
  /** Prefer this project id when selecting from registry. */
  activeProjectId?: string;
  /**
   * Spawn subagent for conductor execution (and tests).
   * When omitted, approved conductor runs only produce a plan summary.
   */
  runSubagent?: (
    request: SubagentRunRequest
  ) => Promise<SubagentRunOutcome>;
}

export interface AgentRunInput {
  input: string;
  requestedMode: AgentMode;
  /** 取消本次前台运行；取消是正常终态，不按失败处理。 */
  signal?: AbortSignal;
  approvals?: {
    plan?: boolean;
  };
}

/** In-memory plan held between /approve and execution (process lifetime). */
export interface PendingConductorExecution {
  goal: string;
  mode: Exclude<AgentMode, 'auto'>;
  plan: ConductorPlan;
  impactMap: ImpactMap;
  projectId: string;
  registrySourcePath?: string;
}

export interface ResolveToolApprovalInput {
  runId: string;
  approved: boolean;
  /** 取消审批后的工具执行与后续模型请求。 */
  signal?: AbortSignal;
}

export interface ContextInspectionInput {
  requestedMode: AgentMode;
  currentUserInput?: string;
}

export interface ContextInspection extends ContextSnapshot {
  mode: Exclude<AgentMode, 'auto'>;
}

export type AgentRuntimeEvent = TraceEvent;

export type AgentRunStreamEvent =
  | {
      type: 'turn-start';
      iteration: number;
    }
  | {
      type: 'tools-start';
      iteration: number;
      count: number;
    }
  | {
      type: 'text-delta';
      text: string;
    }
  | {
      type: 'thinking-delta';
      text: string;
    }
  | {
      type: 'result';
      result: AgentResult;
    };
