import {
  subagentResultSchema,
  type SubagentResult
} from '../domain';
import type {
  LlmClient,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  LlmToolDefinition
} from '../llm/types';
import { createSubagentTools } from '../tools/builtin/exploreTools';
import {
  ToolGateway,
  type ToolMetadata
} from '../tools/toolGateway';
import type { TraceStore } from '../trace/traceStore';
import { extractChangedFilesFromEvents } from '../workspace/changedFiles';

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

/** Dedicated system prompt — NOT the main planner prompt. */
export const SUBAGENT_SYSTEM_PROMPT = [
  'You are a focused subagent of Kross.',
  'Complete the assigned task using only the available tools.',
  'Allowed tools: Read, Glob, Grep, List, Stat, GitStatus/Diff/Log, Edit, Write.',
  'Not available: Bash, Delete, Move, Task, network/MCP, or other high-risk tools.',
  'No user approval is required — use tools freely within the allowlist.',
  'Do not invent tool names. Prefer concrete file paths and a clear final summary:',
  'what you found or changed, key paths, risks, and suggested next steps for the parent agent.'
].join(' ');

/**
 * Run an isolated subagent turn (no AgentRuntime planner shell).
 * - Own system prompt + empty history
 * - Filtered tools with auto-allow
 * - Trace payload always tagged `isSubagent: true`
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
  assertNotAborted(request.signal);

  const subRunId =
    deps.createRunId?.() ??
    `sub-${sanitizeRunIdPart(request.parentRunId)}-${Date.now().toString(36)}`;

  const lifecycleExtras = {
    isSubagent: true,
    subRunId,
    parentRunId: request.parentRunId
  };

  await appendTrace(deps.traceStore, request.parentRunId, 'subagent.started', {
    ...lifecycleExtras,
    mode,
    parentDepth,
    promptPreview: prompt.slice(0, 240),
    autoApprove: true
  });

  if (!deps.llmClient) {
    const failed = subagentResultSchema.parse({
      status: 'failed',
      summary: 'Subagent failed: no LLM client configured',
      changedFiles: [],
      diffSummary: [],
      commandsRun: [],
      evidence: ['子代理未检测到可用 LLM client'],
      risks: ['请配置模型后再派生子代理'],
      needsReview: []
    });
    await appendTrace(deps.traceStore, request.parentRunId, 'subagent.failed', {
      ...lifecycleExtras,
      mode,
      error: failed.summary
    });
    return {
      result: failed,
      subRunId,
      mode,
      modeForcedToExplore: false
    };
  }

  const toolDefs = createSubagentTools(deps.workspaceRoot);
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

  try {
    const summary = await runSubagentToolLoop({
      runId: subRunId,
      prompt,
      llmClient: deps.llmClient,
      gateway: childGateway,
      tools: toolMeta,
      maxIterations: deps.maxToolIterations ?? 40,
      signal: request.signal,
      traceStore: deps.traceStore,
      lifecycleExtras
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
    const message = error instanceof Error ? error.message : String(error);
    await appendTrace(deps.traceStore, request.parentRunId, 'subagent.failed', {
      ...lifecycleExtras,
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

async function runSubagentToolLoop(input: {
  runId: string;
  prompt: string;
  llmClient: LlmClient;
  gateway: ToolGateway;
  tools: ToolMetadata[];
  maxIterations: number;
  signal?: AbortSignal;
  traceStore: TraceStore;
  lifecycleExtras: Record<string, unknown>;
}): Promise<string> {
  let messages: LlmMessage[] = [
    { role: 'system', content: SUBAGENT_SYSTEM_PROMPT },
    { role: 'user', content: input.prompt }
  ];

  let iteration = 1;
  let lastText = '';

  while (iteration <= input.maxIterations) {
    assertNotAborted(input.signal);

    await appendTrace(input.traceStore, input.runId, 'llm.subagent.turn', {
      ...input.lifecycleExtras,
      iteration
    });

    const response = await input.llmClient.complete({
      messages,
      tools: toLlmTools(input.tools),
      temperature: 0.2,
      metadata: {
        purpose: 'subagent',
        iteration,
        isSubagent: true
      }
    });
    lastText = response.text?.trim() ?? '';

    await appendTrace(input.traceStore, input.runId, 'llm.subagent.completed', {
      ...input.lifecycleExtras,
      iteration,
      textPreview: lastText.slice(0, 240),
      toolCallCount: response.toolCalls?.length ?? 0
    });

    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return (
        lastText ||
        'Subagent finished without a text summary.'
      );
    }

    const assistantMessage: LlmMessage = {
      role: 'assistant',
      content: response.text ?? '',
      toolCalls
    };
    const toolMessages = await executeToolCalls({
      runId: input.runId,
      gateway: input.gateway,
      calls: toolCalls,
      signal: input.signal
    });
    messages = [...messages, assistantMessage, ...toolMessages];
    iteration += 1;
  }

  // Soft land: one final text-only turn.
  assertNotAborted(input.signal);
  const soft = await input.llmClient.complete({
    messages: [
      ...messages,
      {
        role: 'user',
        content:
          'Tool iteration limit reached. Summarize findings and remaining work for the parent agent. Do not call tools.'
      }
    ],
    temperature: 0.2,
    metadata: { purpose: 'subagent-soft-land', isSubagent: true }
  });
  return (
    soft.text?.trim() ||
    lastText ||
    `Subagent reached tool iteration limit (${input.maxIterations}).`
  );
}

async function executeToolCalls(input: {
  runId: string;
  gateway: ToolGateway;
  calls: LlmToolCall[];
  signal?: AbortSignal;
}): Promise<LlmMessage[]> {
  const out: LlmMessage[] = [];
  for (const call of input.calls) {
    assertNotAborted(input.signal);
    const result = await input.gateway.call({
      runId: input.runId,
      name: call.name,
      input: call.input,
      callId: call.id,
      returnErrors: true
    });
    out.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: result.content
    });
  }
  return out;
}

function toLlmTools(tools: ToolMetadata[]): LlmToolDefinition[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Subagent run aborted');
  }
}

function sanitizeRunIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'parent';
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
