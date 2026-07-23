import type { ContextSnapshot, SessionContext } from '../context/sessionContext';
import type {
  AgentMode,
  AgentResult,
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
import type { SkillRegistry } from '../skills/skillRegistry';
import type { MutationCoordinator } from '../mutations/mutationService';
import type { ProcessManager } from '../process/processManager';

export type {
  PendingConductorExecution,
  PendingPlanExecution,
  PendingModeExecution
} from '../modes/pendingExecution';

export interface AgentRuntimeOptions {
  traceStore: TraceStore;
  /** 高级模型（指挥家规划 + 验收）；也是默认 agent 模型 */
  llmClient?: LlmClient;
  /**
   * 经济/快速 worker 模型，供指挥家派生子代理时使用。
   * 未配置时子代理回退到 llmClient。
   */
  workerLlmClient?: LlmClient;
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
   * Session multi-directory roots (/add-dir). Orthogonal to modes —
   * any mode may use Task(repoId) against these roots.
   */
  workspaceRoots?: WorkspaceRoots;
  /** Shared dynamic Skill registry. Runtime creates a fallback when omitted. */
  skillRegistry?: SkillRegistry;
  /** Personal Skill directory used by the fallback registry. */
  personalSkillsDir?: string;
  /** Workspace-aware mutation journal and undo coordinator. */
  mutationCoordinator?: MutationCoordinator;
  /** Main-session background process owner. Handles are never persisted. */
  processManager?: ProcessManager;
  /** Loaded ~/.kross/projects.json (optional project template / seed). */
  projectRegistry?: ProjectRegistry;
  /** Absolute path of the registry file (for prompts / errors). */
  projectRegistryPath?: string;
  /** Prefer this project id when selecting from registry. */
  activeProjectId?: string;
  /**
   * Spawn subagent (conductor workers + Task tool).
   * When omitted, conductor cannot fan out workers.
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

export interface ResolveToolApprovalInput {
  runId: string;
  approved: boolean;
  /** 用户拒绝时给 Agent 的修正说明。 */
  reason?: string;
  /** 取消审批后的工具执行与后续模型请求。 */
  signal?: AbortSignal;
}

export interface ContextInspectionInput {
  requestedMode: AgentMode;
  currentUserInput?: string;
}

export interface ContextInspection extends ContextSnapshot {
  mode: AgentMode;
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
