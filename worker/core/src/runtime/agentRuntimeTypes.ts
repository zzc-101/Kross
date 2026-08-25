import type {
  ContextSource,
  SessionContext
} from '../context/sessionContext';
import type { AgentResult, TraceEvent } from '../domain';
import type { LlmClient } from '../llm/types';
import type { TodoStore } from '../todo/todoStore';
import type { ToolGateway } from '../tools/toolGateway';
import type { TraceStore } from '../trace/traceStore';
import type {
  SubagentModelProfileSummary,
  SubagentRunOutcome,
  SubagentRunRequest
} from './subagentRunner';
import type { MutationCoordinator } from '../mutations/mutationService';
import type { SaasActiveSkill } from './saasRuntimePolicy';

export interface AgentRuntimeOptions {
  traceStore: TraceStore;
  /** Active platform-managed Skill for this conversation. */
  activeSkill?: SaasActiveSkill;
  /** Trusted USER.md and MEMORY.md sources loaded by the Worker boundary. */
  memoryContextSources?: ContextSource[];
  /** Default model used by the work agent. */
  llmClient?: LlmClient;
  /**
   * 经济/快速 worker 模型，供子代理使用。
   * 未配置时子代理回退到 llmClient。
   */
  workerLlmClient?: LlmClient;
  /** Live configured model profiles exposed to planning and Task selection. */
  getModelProfiles?: () => SubagentModelProfileSummary[];
  /** Keep host-owned Task/subagent model bindings synchronized with UI switches. */
  onLlmClientChanged?: (client: LlmClient | undefined) => void;
  sessionContext?: SessionContext;
  /** @deprecated 使用 sessionContext */
  contextManager?: SessionContext;
  toolGateway?: ToolGateway;
  maxToolIterations?: number;
  createRunId?: () => string;
  now?: () => Date;
  workspaceRoot?: string;
  /**
   * Nesting depth for subagent runs (0 = main agent).
   * Used by Task tool to forbid nested spawn when depth >= 1.
   */
  subagentDepth?: number;
  /** Session todo list shared with TodoWrite/TodoRead tools. */
  todoStore?: TodoStore;
  /** Workspace-aware mutation journal and undo coordinator. */
  mutationCoordinator?: MutationCoordinator;
  /**
   * Spawn a subagent through the Task tool.
   */
  runSubagent?: (
    request: SubagentRunRequest
  ) => Promise<SubagentRunOutcome>;
}

export interface AgentRunInput {
  input: string;
  /** 取消本次前台运行；取消是正常终态，不按失败处理。 */
  signal?: AbortSignal;
}

export interface ResolveToolApprovalInput {
  runId: string;
  approved: boolean;
  /** 用户拒绝时给 Agent 的修正说明。 */
  reason?: string;
  /** 取消审批后的工具执行与后续模型请求。 */
  signal?: AbortSignal;
}

export interface RunUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
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
      type: 'tool-call';
      id: string;
      name: string;
      input?: unknown;
    }
  | {
      type: 'tool-result';
      id: string;
      name: string;
      content: string;
      ok?: boolean;
    }
  | {
      type: 'result';
      result: AgentResult;
    };
