import { InMemoryContextManager } from '../context/contextManager';
import {
  subagentResultSchema,
  type SubagentResult
} from '../domain';
import type { LlmClient } from '../llm/types';
import { createSubagentTools } from '../tools/builtin/exploreTools';
import { ToolGateway } from '../tools/toolGateway';
import type { TraceStore } from '../trace/traceStore';
import { AgentRuntime } from './agentRuntime';

export type SubagentMode = 'explore' | 'general';

export interface SubagentRunRequest {
  prompt: string;
  /** Optional label; tool set is the same (read + edit, no high-risk tools). */
  mode?: SubagentMode;
  parentRunId: string;
  /** Depth of the caller (0 = main agent). */
  parentDepth?: number;
  signal?: AbortSignal;
}

export interface SubagentRunDeps {
  workspaceRoot: string;
  llmClient?: LlmClient;
  traceStore: TraceStore;
  /** Hard cap for nested spawn; default 1 (children cannot spawn). */
  maxDepth?: number;
  maxToolIterations?: number;
  now?: () => Date;
  createRunId?: () => string;
}

export interface SubagentRunOutcome {
  result: SubagentResult;
  subRunId: string;
  mode: SubagentMode;
  /** @deprecated Always false; kept for tool payload compatibility. */
  modeForcedToExplore: boolean;
}

const SUBAGENT_SYSTEM_HINT = [
  'You are a focused subagent of Kross.',
  'Allowed tools: Read, Glob, Grep, List, Stat, GitStatus/Diff/Log, Edit, Write.',
  'Not available: Bash, Delete, Move, Task, network/MCP, or other high-risk tools.',
  'No user approval is required inside this subagent — use tools freely within the allowlist.',
  'Stay on the assigned task; finish with a clear summary for the parent agent',
  '(what you found/changed, key paths, risks, suggested next steps).'
].join(' ');

/**
 * Run an isolated subagent (independent context + filtered tools, no approvals).
 * Does not inject parent conversation history.
 */
export async function runSubagent(
  request: SubagentRunRequest,
  deps: SubagentRunDeps
): Promise<SubagentRunOutcome> {
  const maxDepth = deps.maxDepth ?? 1;
  const parentDepth = request.parentDepth ?? 0;
  if (parentDepth >= maxDepth) {
    throw new Error(
      `Subagent depth limit reached (maxDepth=${maxDepth}); nested Task is not allowed`
    );
  }

  const mode: SubagentMode = request.mode === 'general' ? 'general' : 'explore';

  const prompt = request.prompt.trim();
  if (!prompt) {
    throw new Error('Subagent prompt must not be empty');
  }

  if (request.signal?.aborted) {
    throw new Error('Subagent run aborted');
  }

  const subRunId =
    deps.createRunId?.() ??
    `sub-${request.parentRunId}-${Date.now().toString(36)}`;

  await appendTrace(deps.traceStore, request.parentRunId, 'subagent.started', {
    subRunId,
    mode,
    parentDepth,
    promptPreview: prompt.slice(0, 240),
    autoApprove: true
  });

  // Auto-allow every registered tool — no interactive approval in subagents.
  const childGateway = new ToolGateway({
    traceStore: deps.traceStore,
    defaultTimeoutMs: 120_000,
    approvalPolicy: () => ({ action: 'allow' })
  });
  for (const tool of createSubagentTools(deps.workspaceRoot)) {
    childGateway.register(tool);
  }

  const childContext = new InMemoryContextManager({
    maxHistoryMessages: 16,
    autoCompact: true
  });
  childContext.addSource({
    id: 'subagent-role',
    kind: 'user',
    title: 'Subagent role',
    content: SUBAGENT_SYSTEM_HINT,
    priority: 100
  });

  const childRuntime = new AgentRuntime({
    traceStore: deps.traceStore,
    llmClient: deps.llmClient,
    toolGateway: childGateway,
    contextManager: childContext,
    workspaceRoot: deps.workspaceRoot,
    maxToolIterations: deps.maxToolIterations ?? 40,
    createRunId: () => subRunId,
    now: deps.now,
    subagentDepth: parentDepth + 1
  });
  // Keep runtime permission mode in sync with gateway auto-allow.
  childRuntime.setPermissionMode('auto');

  try {
    const agentResult = await childRuntime.run({
      input: prompt,
      requestedMode: 'normal'
    });

    const status =
      agentResult.status === 'completed'
        ? 'completed'
        : agentResult.status === 'failed'
          ? 'failed'
          : 'needs-review';

    const result = subagentResultSchema.parse({
      status,
      summary: agentResult.summary,
      changedFiles: agentResult.report.changedFiles ?? [],
      diffSummary: [],
      commandsRun: [],
      evidence: agentResult.report.evidence ?? [],
      risks: agentResult.report.risks ?? [],
      needsReview:
        status === 'needs-review'
          ? [agentResult.pendingApproval?.reason ?? 'needs review']
          : []
    });

    await appendTrace(deps.traceStore, request.parentRunId, 'subagent.completed', {
      subRunId,
      mode,
      status: result.status,
      summaryPreview: result.summary.slice(0, 240),
      evidenceCount: result.evidence.length,
      changedFiles: result.changedFiles
    });

    return {
      result,
      subRunId,
      mode,
      modeForcedToExplore: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendTrace(deps.traceStore, request.parentRunId, 'subagent.failed', {
      subRunId,
      mode,
      error: message
    });
    throw error;
  }
}

export function formatSubagentToolContent(outcome: SubagentRunOutcome): string {
  const { result, subRunId, mode } = outcome;
  const lines = [
    `Subagent ${mode} (${subRunId}) → ${result.status}`,
    '',
    result.summary,
    result.evidence.length > 0
      ? `\nEvidence:\n${result.evidence.map((item) => `- ${item}`).join('\n')}`
      : undefined,
    result.risks.length > 0
      ? `\nRisks:\n${result.risks.map((item) => `- ${item}`).join('\n')}`
      : undefined,
    result.changedFiles.length > 0
      ? `\nChanged files:\n${result.changedFiles.map((item) => `- ${item}`).join('\n')}`
      : undefined
  ].filter((line): line is string => line !== undefined);
  return lines.join('\n');
}

async function appendTrace(
  traceStore: TraceStore,
  runId: string,
  type: string,
  payload: Record<string, unknown>
): Promise<void> {
  await traceStore.append({
    id: `${runId}-${type}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 7)}`,
    runId,
    type,
    timestamp: new Date().toISOString(),
    payload
  });
}
