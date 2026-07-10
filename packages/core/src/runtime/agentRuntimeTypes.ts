import type { ContextManager, ContextSnapshot } from '../context/contextManager';
import type { AgentMode, AgentResult, TraceEvent } from '../domain';
import type { LlmClient } from '../llm/types';
import type { ToolGateway } from '../tools/toolGateway';
import type { TraceStore } from '../trace/traceStore';
import type { GitRunner } from '../workspace/workspaceDiff';

export interface AgentRuntimeOptions {
  traceStore: TraceStore;
  llmClient?: LlmClient;
  contextManager?: ContextManager;
  toolGateway?: ToolGateway;
  maxToolIterations?: number;
  createRunId?: () => string;
  now?: () => Date;
  workspaceRoot?: string;
  runGit?: GitRunner;
}

export interface AgentRunInput {
  input: string;
  requestedMode: AgentMode;
  approvals?: {
    plan?: boolean;
  };
}

export interface ResolveToolApprovalInput {
  runId: string;
  approved: boolean;
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
