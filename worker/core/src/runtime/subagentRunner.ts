import { randomUUID } from 'node:crypto';
import {
  isOperationAborted,
  throwIfAborted
} from '../abort';
import {
  subagentResultSchema
} from '../domain';
import { createSessionContext } from '../context/sessionContext';
import type { LlmClient } from '../llm/types';
import { createSubagentTools } from '../tools/builtin/exploreTools';
import { createReadSkillTool } from '../tools/builtin/readSkill';
import { SkillRegistry } from '../skills/skillRegistry';
import type { MutationService } from '../mutations/mutationService';
import { renderSubagentExecutionPrompt } from '../prompts';
import {
  ToolGateway,
  type ToolMetadata
} from '../tools/toolGateway';
import type { TraceStore } from '../trace/traceStore';
import { extractChangedFilesFromEvents } from '../workspace/changedFiles';
import {
  formatProjectInstructionSource,
  loadProjectInstructions
} from '../workspace/projectInstructions';
import { runCompleteToolLoop } from './completeToolLoop';
import type {
  SubagentMode,
  SubagentRunOutcome,
  SubagentRunRequest,
  SubagentRunner
} from './subagentTypes';

export type {
  SubagentMode,
  SubagentModelProfileSummary,
  SubagentRunOutcome,
  SubagentRunRequest,
  SubagentRunner
} from './subagentTypes';
export { formatSubagentToolContent } from './subagentFormat';

export interface SubagentRunDeps {
  /** Platform-assigned workspace shared by all subagents. */
  workspaceRoot: string;
  /** Default / senior model client */
  llmClient?: LlmClient;
  /** Optional cheaper/faster model for delegated subagents. */
  workerLlmClient?: LlmClient;
  /** Resolve a configured model profile at spawn time. */
  resolveModelProfile?: (profileId: string) => {
    client: LlmClient;
    profile: {
      id: string;
      name: string;
      provider: string;
      model: string;
    };
  };
  traceStore: TraceStore;
  maxDepth?: number;
  maxToolIterations?: number;
  now?: () => Date;
  createRunId?: () => string;
  /** Personal Skill root shared with child agents. */
  personalSkillsDir?: string;
  getMutationService?: (workspaceRoot: string) => MutationService;
}

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
  const goal = request.goal.trim();
  if (!goal) {
    throw new Error('Subagent goal must not be empty');
  }
  throwIfAborted(request.signal);

  const subRunId =
    deps.createRunId?.() ??
    `sub-${sanitizeRunIdPart(request.parentRunId)}-${randomUUID()}`;

  const lifecycleExtras = {
    isSubagent: true,
    subRunId,
    parentRunId: request.parentRunId,
    role: 'worker'
  };

  const title =
    request.title?.trim() ||
    deriveSubagentTitle(goal);

  const workspaceRoot = deps.workspaceRoot;
  const rootId = 'workspace';
  const projectInstructions = loadProjectInstructions({
    roots: [{ id: rootId, path: workspaceRoot, primary: true }]
  });
  const skillRegistry = new SkillRegistry({
    getRoots: () => [{ id: rootId, path: workspaceRoot, primary: true }],
    personalSkillsDir: deps.personalSkillsDir
  });
  const skills = skillRegistry.refresh();
  const requestedProfileId = request.modelProfileId?.trim();
  if (requestedProfileId && !deps.resolveModelProfile) {
    throw new Error('当前 Host 不支持按模型档案派生子代理');
  }
  const resolvedProfile = requestedProfileId
    ? deps.resolveModelProfile?.(requestedProfileId)
    : undefined;
  const useWorker =
    !resolvedProfile &&
    request.preferWorkerModel === true &&
    deps.workerLlmClient !== undefined;
  const llmClient =
    resolvedProfile?.client ??
    (useWorker ? deps.workerLlmClient : deps.llmClient);
  const modelExtras = {
    modelProfileId: resolvedProfile?.profile.id,
    modelProfileName: resolvedProfile?.profile.name,
    model: llmClient?.model
  };

  await appendTrace(deps.traceStore, request.parentRunId, 'subagent.started', {
    ...lifecycleExtras,
    mode,
    parentDepth,
    title,
    workspaceRoot,
    preferWorkerModel: request.preferWorkerModel === true,
    workerModel: useWorker,
    ...modelExtras,
    goalPreview: goal.slice(0, 240),
    autoApprove: true,
    projectInstructions: projectInstructions.files.map((file) => ({
      filename: file.filename,
      rootId: file.rootId,
      truncated: file.truncated,
      injectedBytes: file.injectedBytes
    })),
    projectInstructionDiagnosticCount: projectInstructions.diagnostics.length,
    skills: skills.skills.map((skill) => ({
      id: skill.id,
      rootId: skill.rootId,
      scope: skill.scope
    })),
    skillDiagnosticCount: skills.diagnostics.length
  });

  if (!llmClient) {
    const failed = subagentResultSchema.parse({
      status: 'failed',
      summary: 'Subagent failed: no LLM client configured',
      artifacts: [],
      evidence: [
        useWorker
          ? '子代理未配置 workerLlmClient / 主模型'
          : '子代理未检测到可用 LLM client'
      ],
      incompleteItems: ['请配置模型后再派生子代理']
    });
    await appendTrace(deps.traceStore, request.parentRunId, 'subagent.failed', {
      ...lifecycleExtras,
      mode,
      workspaceRoot,
      ...modelExtras,
      error: failed.summary
    });
    return {
      result: failed,
      subRunId,
      mode,
      modeForcedToExplore: false,
      modelProfileId: resolvedProfile?.profile.id,
      modelProfileName: resolvedProfile?.profile.name
    };
  }

  const availableToolDefs = [
    ...createSubagentTools(workspaceRoot, deps.getMutationService?.(workspaceRoot)),
    createReadSkillTool(skillRegistry)
  ];
  const toolDefs =
    mode === 'explore'
      ? availableToolDefs.filter((tool) => tool.risk === 'read')
      : availableToolDefs;
  const childGateway = new ToolGateway({
    traceStore: deps.traceStore,
    defaultTimeoutMs: 120_000,
    approvalPolicy: ({ tool }) =>
      mode === 'explore'
        ? tool.risk === 'read'
          ? { action: 'allow' }
          : {
              action: 'deny',
              reason: 'explore 子代理只允许只读工具调用'
            }
        : { action: 'allow' },
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
  for (const file of projectInstructions.files) {
    sessionContext.addSource({
      id: file.sourceId,
      kind: 'repo',
      title: `Project instructions: ${file.rootId}/${file.filename}`,
      content: formatProjectInstructionSource(file),
      priority: 99,
      pinned: true
    });
  }
  for (const skill of skills.skills) {
    sessionContext.registerSkill({
      id: skill.descriptorId,
      name: skill.name,
      description: skill.description,
      location: `id=${skill.id} scope=${skill.scope} rootId=${skill.rootId} path=${skill.entryPath}`
    });
  }

  try {
    let stalled = false;
    const summary = await runCompleteToolLoop({
      runId: subRunId,
      prompt: goal,
      systemPrompt: renderSubagentExecutionPrompt({ mode }),
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
      onStallRecovery: async ({
        iteration,
        signaturePreview,
        fingerprint,
        repeatedCount
      }) => {
        await appendTrace(
          deps.traceStore,
          subRunId,
          'llm.subagent.stall_recovery',
          {
            ...lifecycleExtras,
            iteration,
            signaturePreview,
            fingerprint,
            repeatedCount
          }
        );
      },
      onStalled: async ({
        iteration,
        signaturePreview,
        fingerprint,
        repeatedCount
      }) => {
        stalled = true;
        await appendTrace(deps.traceStore, subRunId, 'llm.subagent.stalled', {
          ...lifecycleExtras,
          iteration,
          signaturePreview,
          fingerprint,
          repeatedCount
        });
      }
    });

    let artifacts: string[] = [];
    let toolsUsed: string[] = [];
    let toolEvidence: string[] = [];
    try {
      const events = await deps.traceStore.readRun(subRunId);
      artifacts = extractChangedFilesFromEvents(events);
      toolsUsed = [
        ...new Set(
          events
            .filter((event) => event.type === 'tool_call.completed')
            .map((event) => event.payload.toolName)
            .filter((name): name is string => typeof name === 'string')
        )
      ];
      toolEvidence = events.flatMap((event) => {
        if (event.type !== 'tool_call.completed') return [];
        const toolName = event.payload.toolName;
        const summary = event.payload.summary;
        return typeof toolName === 'string' && typeof summary === 'string'
          ? [`${toolName}: ${summary}`]
          : [];
      });
    } catch {
      // Trace-derived artifacts and evidence are best-effort.
    }

    const result = subagentResultSchema.parse({
      status: stalled ? 'incomplete' : 'completed',
      summary,
      artifacts,
      toolsUsed,
      evidence: [
        stalled
          ? '子代理在一次恢复提示后仍重复相同工具调用，且结果没有变化'
          : '子代理已完成独立工具环',
        ...(artifacts.length > 0
          ? [`产出文件 ${artifacts.length} 个`]
          : []),
        ...toolEvidence
      ],
      incompleteItems: stalled
        ? ['父 Agent 需要检查阻塞证据并调整策略']
        : []
    });

    await appendTrace(deps.traceStore, request.parentRunId, 'subagent.completed', {
      ...lifecycleExtras,
      ...modelExtras,
      mode,
      status: result.status,
      summaryPreview: result.summary.slice(0, 240),
      evidenceCount: result.evidence.length,
      artifacts: result.artifacts,
      incompleteItems: result.incompleteItems,
      toolsUsed: result.toolsUsed
    });

    return {
      result,
      subRunId,
      mode,
      modeForcedToExplore: false,
      modelProfileId: resolvedProfile?.profile.id,
      modelProfileName: resolvedProfile?.profile.name,
      model: llmClient.model
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
        ...modelExtras,
        mode,
        reason:
          error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    await appendTrace(deps.traceStore, request.parentRunId, 'subagent.failed', {
      ...lifecycleExtras,
      ...modelExtras,
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

/** Derive a short progress title when the caller omitted one. */
export function deriveSubagentTitle(goal: string, maxLen = 36): string {
  const oneLine = goal.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) {
    return 'Task';
  }
  if (oneLine.length <= maxLen) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(0, maxLen - 1))}…`;
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
