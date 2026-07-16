import { resolve } from 'node:path';

import {
  isOperationAborted,
  throwIfAborted
} from '../abort';
import { subagentResultSchema } from '../domain';
import { createSessionContext } from '../context/sessionContext';
import type { LlmClient } from '../llm/types';
import { createSubagentTools } from '../tools/builtin/exploreTools';
import {
  ToolGateway,
  type ToolMetadata
} from '../tools/toolGateway';
import type { TraceStore } from '../trace/traceStore';
import { extractChangedFilesFromEvents } from '../workspace/changedFiles';
import { runCompleteToolLoop } from './completeToolLoop';
import type {
  SubagentMode,
  SubagentRunOutcome,
  SubagentRunRequest,
  SubagentRunner
} from './subagentTypes';

export type {
  SubagentMode,
  SubagentRunOutcome,
  SubagentRunRequest,
  SubagentRunner
} from './subagentTypes';
export { formatSubagentToolContent } from './subagentFormat';

export interface SubagentRunDeps {
  /** Default workspace when request.workspaceRoot is omitted. */
  workspaceRoot: string;
  /**
   * Absolute roots Task may target. When set, request.workspaceRoot must
   * equal one of these (or be nested under one). When unset, only the default
   * workspaceRoot is allowed for overrides.
   * Prefer getAllowedWorkspaceRoots for live /add-dir updates.
   */
  allowedWorkspaceRoots?: string[];
  /** Dynamic allowlist (e.g. WorkspaceRoots.allowedRoots). Overrides static list. */
  getAllowedWorkspaceRoots?: () => string[];
  /** Default / senior model client */
  llmClient?: LlmClient;
  /** Cheaper/faster worker model for conductor-spawned subagents */
  workerLlmClient?: LlmClient;
  traceStore: TraceStore;
  maxDepth?: number;
  maxToolIterations?: number;
  now?: () => Date;
  createRunId?: () => string;
}

export const SUBAGENT_SYSTEM_PROMPT = [
  'You are a focused subagent of Kross.',
  'Complete the assigned task using only the available tools.',
  'Allowed tools: Read, Glob, Grep, Rg, List, Stat, GitStatus/Diff/Log, Edit, Write.',
  'Prefer Rg (ripgrep) over Grep/Glob for search and file listing when available.',
  'Not available: Bash, Delete, Move, Task, network/MCP, or other high-risk tools.',
  'No user approval is required — use tools freely within the allowlist.',
  'Do not invent tool names. Prefer concrete file paths and a clear final summary:',
  'what you found or changed, key paths, risks, and suggested next steps for the parent agent.'
].join(' ');

/**
 * 子代理独立 SessionContext（减半预算）+ 同一套治理流水线。
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
  throwIfAborted(request.signal);

  const subRunId =
    deps.createRunId?.() ??
    `sub-${sanitizeRunIdPart(request.parentRunId)}-${Date.now().toString(36)}`;

  const lifecycleExtras = {
    isSubagent: true,
    subRunId,
    parentRunId: request.parentRunId
  };

  const title =
    request.title?.trim() ||
    deriveSubagentTitle(prompt);

  const workspaceRoot = resolveSubagentWorkspaceRoot(request, deps);
  const useWorker =
    request.preferWorkerModel === true && deps.workerLlmClient !== undefined;
  const llmClient = useWorker ? deps.workerLlmClient : deps.llmClient;

  await appendTrace(deps.traceStore, request.parentRunId, 'subagent.started', {
    ...lifecycleExtras,
    mode,
    parentDepth,
    title,
    repoId: request.repoId,
    workspaceRoot,
    preferWorkerModel: request.preferWorkerModel === true,
    workerModel: useWorker,
    model: llmClient?.model,
    promptPreview: prompt.slice(0, 240),
    autoApprove: true
  });

  if (!llmClient) {
    const failed = subagentResultSchema.parse({
      status: 'failed',
      summary: 'Subagent failed: no LLM client configured',
      changedFiles: [],
      diffSummary: [],
      commandsRun: [],
      evidence: [
        useWorker
          ? '指挥家 worker 子代理未配置 workerLlmClient / 主模型'
          : '子代理未检测到可用 LLM client'
      ],
      risks: ['请配置模型后再派生子代理'],
      needsReview: []
    });
    await appendTrace(deps.traceStore, request.parentRunId, 'subagent.failed', {
      ...lifecycleExtras,
      mode,
      repoId: request.repoId,
      workspaceRoot,
      error: failed.summary
    });
    return {
      result: failed,
      subRunId,
      mode,
      modeForcedToExplore: false
    };
  }

  const toolDefs = createSubagentTools(workspaceRoot);
  const childGateway = new ToolGateway({
    traceStore: deps.traceStore,
    defaultTimeoutMs: 120_000,
    approvalPolicy: () => ({ action: 'allow' }),
    tracePayloadExtras: {
      isSubagent: true,
      subRunId,
      parentRunId: request.parentRunId
    }
  });
  for (const tool of toolDefs) {
    childGateway.register(tool);
  }

  const toolMeta: ToolMetadata[] = toolDefs.map(
    ({ name, description, risk, category, parameters }) => ({
      name,
      description,
      risk,
      category,
      parameters
    })
  );

  const sessionContext = createSessionContext({
    client: llmClient,
    isSubagent: true,
    contextWindow: llmClient.contextWindow
  });

  try {
    const summary = await runCompleteToolLoop({
      runId: subRunId,
      prompt,
      systemPrompt: SUBAGENT_SYSTEM_PROMPT,
      mode: 'auto',
      llmClient,
      gateway: childGateway,
      tools: toolMeta,
      sessionContext,
      maxIterations: deps.maxToolIterations ?? 40,
      signal: request.signal,
      temperature: 0.2,
      purpose: 'subagent',
      softLandPurpose: 'subagent-soft-land',
      onTurn: async ({ iteration }) => {
        await appendTrace(deps.traceStore, subRunId, 'llm.subagent.turn', {
          ...lifecycleExtras,
          iteration
        });
      },
      onCompleted: async ({ iteration, textPreview, toolCallCount }) => {
        await appendTrace(deps.traceStore, subRunId, 'llm.subagent.completed', {
          ...lifecycleExtras,
          iteration,
          textPreview,
          toolCallCount
        });
      },
      onStalled: async ({ iteration, signaturePreview }) => {
        await appendTrace(deps.traceStore, subRunId, 'llm.subagent.stalled', {
          ...lifecycleExtras,
          iteration,
          signaturePreview
        });
      }
    });

    let changedFiles: string[] = [];
    try {
      const events = await deps.traceStore.readRun(subRunId);
      changedFiles = extractChangedFilesFromEvents(events);
    } catch {
      // ignore
    }

    const result = subagentResultSchema.parse({
      status: 'completed',
      summary,
      changedFiles,
      diffSummary: [],
      commandsRun: [],
      evidence: [
        '子代理已完成独立工具环',
        ...(changedFiles.length > 0
          ? [`修改文件 ${changedFiles.length} 个`]
          : [])
      ],
      risks: [],
      needsReview: []
    });

    await appendTrace(deps.traceStore, request.parentRunId, 'subagent.completed', {
      ...lifecycleExtras,
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
    try {
      sessionContext.interruptTurn(
        isOperationAborted(error, request.signal)
          ? '用户中断了子代理'
          : error instanceof Error
            ? error.message
            : String(error)
      );
    } catch {
      // open-turn 收口失败不掩盖原始错误
    }
    if (isOperationAborted(error, request.signal)) {
      await appendTrace(deps.traceStore, request.parentRunId, 'subagent.cancelled', {
        ...lifecycleExtras,
        mode,
        reason:
          error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    await appendTrace(deps.traceStore, request.parentRunId, 'subagent.failed', {
      ...lifecycleExtras,
      mode,
      error: message
    });
    throw error;
  }
}

/** Build a default Task runner bound to shared LLM/trace/workspace. */
export function createDefaultSubagentRunner(
  deps: SubagentRunDeps
): SubagentRunner {
  return (request) => runSubagent(request, deps);
}

function sanitizeRunIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'parent';
}

/** 从 prompt 压出短标题（无 description 时的回退）。 */
export function deriveSubagentTitle(prompt: string, maxLen = 36): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) {
    return 'Task';
  }
  if (oneLine.length <= maxLen) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxLen - 1))}…`;
}

/**
 * Resolve and allowlist-check the workspace root for a subagent spawn.
 */
export function resolveSubagentWorkspaceRoot(
  request: Pick<SubagentRunRequest, 'workspaceRoot'>,
  deps: Pick<
    SubagentRunDeps,
    'workspaceRoot' | 'allowedWorkspaceRoots' | 'getAllowedWorkspaceRoots'
  >
): string {
  const fallback = resolve(deps.workspaceRoot);
  const requested = request.workspaceRoot?.trim()
    ? resolve(request.workspaceRoot.trim())
    : fallback;

  const dynamic = deps.getAllowedWorkspaceRoots?.() ?? [];
  const staticList = deps.allowedWorkspaceRoots ?? [];
  const combined =
    dynamic.length > 0
      ? dynamic
      : staticList.length > 0
        ? staticList
        : [fallback];
  const allow = combined.map((root) => resolve(root));

  if (!isPathAllowed(requested, allow)) {
    throw new Error(
      `Subagent workspaceRoot not allowed: ${requested}. ` +
        `Allowed roots: ${allow.join(', ')}`
    );
  }
  return requested;
}

function isPathAllowed(target: string, allowList: string[]): boolean {
  for (const root of allowList) {
    if (target === root || target.startsWith(root + '/') || target.startsWith(root + '\\')) {
      return true;
    }
  }
  return false;
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