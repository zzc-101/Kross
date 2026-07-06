import { EventEmitter } from 'node:events';

import {
  type AgentMode,
  type AgentResult,
  type PendingToolApproval,
  type TraceEvent,
  agentResultSchema
} from '../domain';
import {
  InMemoryContextManager,
  type ContextManager,
  type ContextSnapshot
} from '../context/contextManager';
import type {
  LlmClient,
  LlmMessage,
  LlmResponse,
  LlmToolDefinition
} from '../llm/types';
import { detectMode } from '../modes/modeDetector';
import {
  ToolGateway,
  ToolPermissionError,
  type ToolMetadata,
  type ToolResult
} from '../tools/toolGateway';
import type { TraceStore } from '../trace/traceStore';

export interface AgentRuntimeOptions {
  traceStore: TraceStore;
  llmClient?: LlmClient;
  contextManager?: ContextManager;
  toolGateway?: ToolGateway;
  maxToolIterations?: number;
  createRunId?: () => string;
  now?: () => Date;
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

type PlannerOutcome =
  | { kind: 'response'; response: LlmResponse }
  | { kind: 'approval'; result: AgentResult }
  | undefined;

interface PendingToolSession {
  runId: string;
  mode: Exclude<AgentMode, 'auto'>;
  call: NonNullable<LlmResponse['toolCalls']>[number];
  messages: LlmMessage[];
  tools: ToolMetadata[];
  iteration: number;
}

type ToolCallExecutionOutcome =
  | { kind: 'result'; result: ToolResult }
  | { kind: 'approval'; result: AgentResult };

const PLANNER_SYSTEM_PROMPT =
  '你是本地 agent 的规划器。请基于模式和用户目标给出简短、可执行的计划。需要工具时，只能基于可用工具清单提出调用意图，不要编造工具。';

export class AgentRuntime extends EventEmitter {
  private readonly createRunId: () => string;
  private readonly now: () => Date;
  private readonly contextManager: ContextManager;
  private readonly toolGateway: ToolGateway | undefined;
  private readonly pendingToolSessions = new Map<string, PendingToolSession>();

  constructor(private readonly options: AgentRuntimeOptions) {
    super();
    this.createRunId =
      options.createRunId ?? (() => `run-${Date.now().toString(36)}`);
    this.now = options.now ?? (() => new Date());
    this.contextManager = options.contextManager ?? new InMemoryContextManager();
    this.toolGateway = options.toolGateway;
  }

  async run(input: AgentRunInput): Promise<AgentResult> {
    const runId = this.createRunId();

    await this.record(runId, 'run.started', { input: input.input });
    await this.record(runId, 'planner.started', {
      requestedMode: input.requestedMode
    });

    const detection = detectMode({
      requestedMode: input.requestedMode,
      input: input.input
    });

    await this.record(runId, 'mode.detected', { ...detection });

    const plannerOutcome = await this.createPlannerSuggestion(
      runId,
      input.input,
      detection.mode
    );
    if (plannerOutcome?.kind === 'approval') {
      await this.record(runId, 'run.awaiting_approval', {
        pendingApproval: plannerOutcome.result.pendingApproval
      });
      return plannerOutcome.result;
    }
    const plannerSuggestion =
      plannerOutcome?.kind === 'response' ? plannerOutcome.response : undefined;

    const plan = createPlan(input.input, detection.mode, plannerSuggestion?.text);
    await this.record(runId, 'plan.created', plan);

    if (detection.mode === 'normal' && !plannerSuggestion) {
      const missingModel = agentResultSchema.parse({
        runId,
        mode: detection.mode,
        status: 'failed',
        summary:
          '未配置模型，无法生成真实回复。请配置 AGENT_LLM_PROVIDER 以及对应的 OPENAI_* 或 ANTHROPIC_* 环境变量后重试。',
        report: {
          changedFiles: [],
          evidence: ['未检测到可用 LLM client'],
          risks: []
        }
      });

      await this.record(runId, 'review.completed', {
        status: missingModel.status,
        summary: missingModel.summary
      });
      await this.record(runId, 'run.completed', { ...missingModel });
      return missingModel;
    }

    if (detection.mode === 'cross-repo') {
      await this.record(runId, 'approval.required', {
        scope: 'cross-repo-plan',
        reason: detection.reason
      });

      if (input.approvals?.plan !== true) {
        const cancelled = agentResultSchema.parse({
          runId,
          mode: detection.mode,
          status: 'cancelled',
          summary: '跨仓库计划等待确认，当前运行已取消',
          report: {
            changedFiles: [],
            evidence: [
              ...(plannerSuggestion ? ['planner LLM 已返回计划建议'] : []),
              '已在执行前触发确认门'
            ],
            risks: []
          }
        });
        await this.record(runId, 'run.completed', { ...cancelled });
        this.appendConversation(input.input, cancelled.summary);
        return cancelled;
      }

      await this.record(runId, 'impact_map.created', {
        strategy: 'codegraph-placeholder',
        repos: [],
        note: '后续接入 codegraph adapter 后填充真实影响面'
      });
    }

    const result = agentResultSchema.parse({
      runId,
      mode: detection.mode,
      status: 'completed',
      summary:
        detection.mode === 'cross-repo'
          ? '跨仓库任务计划已创建，等待接入子代理执行'
          : plannerSuggestion?.text ?? '未配置模型，无法生成真实回复。',
      report: {
        changedFiles: [],
        evidence:
          detection.mode === 'cross-repo'
            ? [
                ...(plannerSuggestion ? ['planner LLM 已返回计划建议'] : []),
                '已生成跨仓库影响面占位图'
              ]
            : [
                ...(plannerSuggestion ? ['planner LLM 已返回计划建议'] : []),
                '已记录普通任务 trace'
              ],
        risks:
          detection.mode === 'cross-repo'
            ? ['当前版本尚未接入真实 codegraph 和子代理执行']
            : []
      }
    });

    await this.record(runId, 'review.completed', {
      status: result.status,
      summary: result.summary
    });
    await this.record(runId, 'run.completed', { ...result });
    this.appendConversation(input.input, result.summary);

    return result;
  }

  inspectContext(input: ContextInspectionInput): ContextInspection {
    const currentUserInput = input.currentUserInput ?? '';
    const mode =
      input.requestedMode === 'auto'
        ? currentUserInput.trim().length > 0
          ? detectMode({
              requestedMode: input.requestedMode,
              input: currentUserInput
            }).mode
          : 'normal'
        : input.requestedMode;
    const snapshot = this.contextManager.build({
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      currentUserInput,
      mode,
      tools: this.toolGateway?.listTools({ mode }) ?? []
    });

    return {
      ...snapshot,
      mode
    };
  }

  async resolveToolApproval(input: ResolveToolApprovalInput): Promise<AgentResult> {
    const session = this.pendingToolSessions.get(input.runId);
    if (!session) {
      throw new Error(`No pending tool approval for run: ${input.runId}`);
    }
    this.pendingToolSessions.delete(input.runId);

    const toolMessage = input.approved
      ? await this.executeApprovedToolCall(session)
      : await this.createRejectedToolMessage(session);
    const messages: LlmMessage[] = [
      ...session.messages,
      toolMessage
    ];
    const response = await this.options.llmClient!.complete({
      messages,
      tools: toLlmTools(session.tools),
      maxTokens: 800,
      temperature: 0.2,
      metadata: {
        purpose: 'planner-tool-followup',
        approvalResolved: input.approved,
        iteration: session.iteration
      }
    });
    const finalResponse = await this.continueToolLoop({
      runId: session.runId,
      response,
      messages,
      tools: session.tools,
      iteration: session.iteration
    });
    const result = agentResultSchema.parse({
      runId: session.runId,
      mode: session.mode,
      status: 'completed',
      summary: finalResponse.text,
      report: {
        changedFiles: [],
        evidence: ['工具审批已处理，planner LLM 已返回最终回复'],
        risks: []
      }
    });

    await this.record(session.runId, 'run.completed', { ...result });
    this.appendConversation('[tool approval]', result.summary);
    return result;
  }

  private async createPlannerSuggestion(
    runId: string,
    goal: string,
    mode: Exclude<AgentMode, 'auto'>
  ): Promise<PlannerOutcome> {
    if (!this.options.llmClient) {
      return undefined;
    }

    try {
      const availableTools = this.toolGateway?.listTools({ mode }) ?? [];
      const context = this.contextManager.build({
        systemPrompt: PLANNER_SYSTEM_PROMPT,
        currentUserInput: goal,
        mode,
        tools: availableTools
      });

      await this.record(runId, 'context.built', {
        includedSources: context.includedSources,
        droppedSources: context.droppedSources,
        estimatedChars: context.estimatedChars,
        report: context.report
      });

      const response = await this.options.llmClient.complete({
        messages: context.messages,
        tools: toLlmTools(availableTools),
        maxTokens: 800,
        temperature: 0.2,
        metadata: {
          purpose: 'planner',
          includedSources: context.includedSources,
          droppedSources: context.droppedSources,
          contextReport: context.report
        }
      });

      await this.record(runId, 'llm.planner.completed', {
        provider: response.provider,
        model: response.model,
        textPreview: response.text.slice(0, 240),
        usage: response.usage,
        toolCallCount: response.toolCalls?.length ?? 0
      });

      if (response.toolCalls?.length && this.toolGateway) {
        return this.runToolFollowup({
          runId,
          mode,
          initialResponse: response,
          messages: context.messages,
          tools: availableTools
        });
      }

      return { kind: 'response', response };
    } catch (error) {
      await this.record(runId, 'llm.planner.failed', {
        message: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  private async runToolFollowup(input: {
    runId: string;
    mode: Exclude<AgentMode, 'auto'>;
    initialResponse: LlmResponse;
    messages: LlmMessage[];
    tools: ToolMetadata[];
  }): Promise<PlannerOutcome> {
    await this.record(input.runId, 'llm.tool_calls.received', {
      count: input.initialResponse.toolCalls?.length ?? 0,
      calls: input.initialResponse.toolCalls?.map((call) => ({
        id: call.id,
        name: call.name
      }))
    });

    const toolMessages: LlmMessage[] = [];
    for (const call of input.initialResponse.toolCalls ?? []) {
      const result = await this.callToolOrPause({
        runId: input.runId,
        mode: input.mode,
        call,
        messages: [
          ...input.messages,
          {
            role: 'assistant',
            content: input.initialResponse.text,
            toolCalls: input.initialResponse.toolCalls
          }
        ],
        tools: input.tools,
        iteration: 1
      });
      if (result.kind === 'approval') {
        return result;
      }
      this.contextManager.recordToolResult({
        id: call.id,
        toolName: call.name,
        inputPreview: JSON.stringify(call.input).slice(0, 200),
        output: result.result.content,
        summary: result.result.summary
      });
      toolMessages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.result.content
      });
    }

    const response = await this.options.llmClient!.complete({
      messages: [
        ...input.messages,
        {
          role: 'assistant',
          content: input.initialResponse.text,
          toolCalls: input.initialResponse.toolCalls
        },
        ...toolMessages
      ],
      tools: toLlmTools(input.tools),
      maxTokens: 800,
      temperature: 0.2,
      metadata: {
        purpose: 'planner-tool-followup',
        toolCallCount: toolMessages.length
      }
    });

    const finalResponse = await this.continueToolLoop({
      ...input,
      messages: [
        ...input.messages,
        {
          role: 'assistant',
          content: input.initialResponse.text,
          toolCalls: input.initialResponse.toolCalls
        },
        ...toolMessages
      ],
      response,
      iteration: 1
    });
    return { kind: 'response', response: finalResponse };
  }

  private async continueToolLoop(input: {
    runId: string;
    response: LlmResponse;
    messages: LlmMessage[];
    tools: ToolMetadata[];
    iteration: number;
  }): Promise<LlmResponse> {
    await this.record(input.runId, 'llm.tool_followup.completed', {
      provider: input.response.provider,
      model: input.response.model,
      textPreview: input.response.text.slice(0, 240),
      usage: input.response.usage,
      toolCallCount: input.response.toolCalls?.length ?? 0,
      iteration: input.iteration
    });

    const maxIterations = this.options.maxToolIterations ?? 4;
    if (!input.response.toolCalls?.length || input.iteration >= maxIterations) {
      return input.response;
    }

    const toolMessages: LlmMessage[] = [];
    for (const call of input.response.toolCalls) {
      const result = await this.toolGateway!.call({
        runId: input.runId,
        name: call.name,
        input: call.input,
        returnErrors: true
      });
      this.contextManager.recordToolResult({
        id: call.id,
        toolName: call.name,
        inputPreview: JSON.stringify(call.input).slice(0, 200),
        output: result.content,
        summary: result.summary
      });
      toolMessages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.content
      });
    }

    const nextMessages: LlmMessage[] = [
      ...input.messages,
      {
        role: 'assistant',
        content: input.response.text,
        toolCalls: input.response.toolCalls
      },
      ...toolMessages
    ];
    const response = await this.options.llmClient!.complete({
      messages: nextMessages,
      tools: toLlmTools(input.tools),
      maxTokens: 800,
      temperature: 0.2,
      metadata: {
        purpose: 'planner-tool-followup',
        toolCallCount: toolMessages.length,
        iteration: input.iteration + 1
      }
    });

    return this.continueToolLoop({
      ...input,
      messages: nextMessages,
      response,
      iteration: input.iteration + 1
    });
  }

  private async callToolOrPause(input: PendingToolSession): Promise<ToolCallExecutionOutcome> {
    try {
      const result = await this.toolGateway!.call({
        runId: input.runId,
        name: input.call.name,
        input: input.call.input,
        returnErrors: true
      });
      return { kind: 'result', result };
    } catch (error) {
      if (error instanceof ToolPermissionError) {
        return {
          kind: 'approval',
          result: this.createPendingToolApprovalResult(input, error)
        };
      }
      throw error;
    }
  }

  private async executeApprovedToolCall(session: PendingToolSession): Promise<LlmMessage> {
    const result = await this.toolGateway!.call({
      runId: session.runId,
      name: session.call.name,
      input: session.call.input,
      approved: true,
      returnErrors: true
    });
    this.contextManager.recordToolResult({
      id: session.call.id,
      toolName: session.call.name,
      inputPreview: JSON.stringify(session.call.input).slice(0, 200),
      output: result.content,
      summary: result.summary
    });

    return {
      role: 'tool',
      toolCallId: session.call.id,
      name: session.call.name,
      content: result.content
    };
  }

  private async createRejectedToolMessage(session: PendingToolSession): Promise<LlmMessage> {
    const content = `Tool ${session.call.name} rejected by user.`;
    await this.record(session.runId, 'tool_call.rejected', {
      toolName: session.call.name,
      toolCallId: session.call.id,
      input: session.call.input
    });
    this.contextManager.recordToolResult({
      id: session.call.id,
      toolName: session.call.name,
      inputPreview: JSON.stringify(session.call.input).slice(0, 200),
      output: content,
      summary: 'rejected by user'
    });

    return {
      role: 'tool',
      toolCallId: session.call.id,
      name: session.call.name,
      content
    };
  }

  private createPendingToolApprovalResult(
    session: PendingToolSession,
    error: ToolPermissionError
  ): AgentResult {
    const metadata = session.tools.find((tool) => tool.name === session.call.name);
    const pendingApproval: PendingToolApproval = {
      runId: session.runId,
      toolCallId: session.call.id,
      toolName: session.call.name,
      risk: metadata?.risk ?? error.risk,
      reason: error.reason,
      inputPreview: JSON.stringify(session.call.input).slice(0, 500)
    };
    this.pendingToolSessions.set(session.runId, session);

    return agentResultSchema.parse({
      runId: session.runId,
      mode: session.mode,
      status: 'approval-required',
      summary: `需要确认工具调用：${session.call.name}`,
      pendingApproval,
      report: {
        changedFiles: [],
        evidence: ['模型请求了需要用户确认的工具调用'],
        risks: [`${pendingApproval.risk} tool requires approval`]
      }
    });
  }

  private appendConversation(userInput: string, assistantOutput: string): void {
    this.contextManager.appendConversation({
      role: 'user',
      content: userInput
    });
    this.contextManager.appendConversation({
      role: 'assistant',
      content: assistantOutput
    });
  }

  private async record(
    runId: string,
    type: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const event: TraceEvent = {
      id: `${runId}-${type}-${this.now().getTime()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      runId,
      type,
      timestamp: this.now().toISOString(),
      payload
    };

    await this.options.traceStore.append(event);
    this.emit('event', event);
  }
}

function createPlan(
  goal: string,
  mode: Exclude<AgentMode, 'auto'>,
  llmSuggestion?: string
) {
  if (mode === 'cross-repo') {
    return {
      goal,
      llmSuggestion,
      steps: [
        '读取 project registry',
        '使用 codegraph 生成跨仓库影响面',
        '拆分 repo 级子任务',
        '等待用户确认后执行'
      ]
    };
  }

  return {
    goal,
    llmSuggestion,
    steps: ['理解目标', '探索当前 workspace', '执行修改或回答', '验收并记录 trace']
  };
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
