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
  LlmToolCall,
  LlmToolDefinition
} from '../llm/types';
import { detectMode } from '../modes/modeDetector';
import {
  ToolGateway,
  ToolPermissionError,
  type ToolMetadata,
  type ToolResult
} from '../tools/toolGateway';
import {
  createApprovalPolicy,
  type PermissionMode
} from '../tools/permissionModes';
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

export type AgentRunStreamEvent =
  | {
      type: 'text-delta';
      text: string;
    }
  | {
      type: 'result';
      result: AgentResult;
    };

type PlannerOutcome =
  | { kind: 'response'; response: LlmResponse }
  | { kind: 'approval'; result: AgentResult }
  | { kind: 'failure'; message: string }
  | undefined;

type ToolLoopOutcome =
  | { kind: 'response'; response: LlmResponse }
  | { kind: 'approval'; result: AgentResult };

type ToolBatchOutcome =
  | { kind: 'completed'; toolMessages: LlmMessage[] }
  | { kind: 'approval'; result: AgentResult };

interface PendingToolSession {
  runId: string;
  mode: Exclude<AgentMode, 'auto'>;
  call: LlmToolCall;
  // 同一批 tool_calls 中排在当前调用之后、还未执行的调用。
  remainingCalls: LlmToolCall[];
  // 同一批中已经执行完成的 tool 消息，恢复时需要原样回填给模型。
  completedToolMessages: LlmMessage[];
  messages: LlmMessage[];
  tools: ToolMetadata[];
  iteration: number;
}

const PLANNER_SYSTEM_PROMPT =
  '你是本地 agent 的规划器。请基于模式和用户目标给出简短、可执行的计划。需要工具时，只能基于可用工具清单提出调用意图，不要编造工具。';

export class AgentRuntime extends EventEmitter {
  private readonly createRunId: () => string;
  private readonly now: () => Date;
  private readonly contextManager: ContextManager;
  private readonly toolGateway: ToolGateway | undefined;
  private readonly pendingToolSessions = new Map<string, PendingToolSession>();
  private permissionMode: PermissionMode = 'default';

  constructor(private readonly options: AgentRuntimeOptions) {
    super();
    this.createRunId =
      options.createRunId ?? (() => `run-${Date.now().toString(36)}`);
    this.now = options.now ?? (() => new Date());
    this.contextManager = options.contextManager ?? new InMemoryContextManager();
    this.toolGateway = options.toolGateway;
    if (this.toolGateway) {
      this.toolGateway.setApprovalPolicy(createApprovalPolicy(this.permissionMode));
    }
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
    this.toolGateway?.setApprovalPolicy(createApprovalPolicy(mode));
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
    if (plannerOutcome?.kind === 'failure') {
      const failed = agentResultSchema.parse({
        runId,
        mode: detection.mode,
        status: 'failed',
        summary: `模型请求失败：${plannerOutcome.message}`,
        report: {
          changedFiles: [],
          evidence: [`LLM 请求失败: ${plannerOutcome.message}`],
          risks: ['请检查模型名称、baseUrl、鉴权方式或网络连通性']
        }
      });
      await this.record(runId, 'review.completed', {
        status: failed.status,
        summary: failed.summary
      });
      await this.record(runId, 'run.completed', { ...failed });
      return failed;
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

  async *runStreaming(input: AgentRunInput): AsyncIterable<AgentRunStreamEvent> {
    const detection = detectMode({
      requestedMode: input.requestedMode,
      input: input.input
    });
    if (detection.mode !== 'normal' || !this.options.llmClient) {
      yield { type: 'result', result: await this.run(input) };
      return;
    }

    const runId = this.createRunId();

    await this.record(runId, 'run.started', { input: input.input });
    await this.record(runId, 'planner.started', {
      requestedMode: input.requestedMode
    });
    await this.record(runId, 'mode.detected', { ...detection });

    const tools = this.toolGateway?.listTools({ mode: detection.mode }) ?? [];
    const context = this.contextManager.build({
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      currentUserInput: input.input,
      mode: detection.mode,
      tools
    });

    await this.record(runId, 'context.built', {
      includedSources: context.includedSources,
      droppedSources: context.droppedSources,
      estimatedChars: context.estimatedChars,
      report: context.report
    });

    const maxIterations = this.options.maxToolIterations ?? 4;
    let messages = context.messages;
    let iteration = 1;
    let fullText = '';

    try {
      while (true) {
        let turnText = '';
        const toolCalls: LlmToolCall[] = [];

        for await (const chunk of this.options.llmClient.stream({
          messages,
          tools: toLlmTools(tools),
          maxTokens: 800,
          temperature: 0.2,
          metadata: {
            purpose: iteration === 1 ? 'planner' : 'planner-tool-followup',
            iteration,
            includedSources: context.includedSources,
            droppedSources: context.droppedSources,
            contextReport: context.report
          }
        })) {
          if (chunk.type === 'text-delta') {
            if (turnText.length === 0 && fullText.length > 0) {
              fullText += '\n\n';
              yield { type: 'text-delta', text: '\n\n' };
            }
            turnText += chunk.text;
            fullText += chunk.text;
            yield { type: 'text-delta', text: chunk.text };
          } else if (chunk.type === 'tool-call') {
            toolCalls.push(chunk.call);
          }
        }

        await this.record(
          runId,
          iteration === 1 ? 'llm.planner.completed' : 'llm.tool_followup.completed',
          {
            provider: this.options.llmClient.provider,
            model: 'stream',
            textPreview: turnText.slice(0, 240),
            toolCallCount: toolCalls.length,
            ...(iteration === 1 ? {} : { iteration })
          }
        );

        if (toolCalls.length === 0 || !this.toolGateway || iteration > maxIterations) {
          break;
        }

        await this.record(runId, 'llm.tool_calls.received', {
          count: toolCalls.length,
          iteration,
          calls: toolCalls.map((call) => ({ id: call.id, name: call.name }))
        });

        const assistantMessage: LlmMessage = {
          role: 'assistant',
          content: turnText,
          toolCalls
        };
        const batchMessages: LlmMessage[] = [...messages, assistantMessage];
        const batch = await this.executeToolBatch({
          runId,
          mode: detection.mode,
          calls: toolCalls,
          completedToolMessages: [],
          messages: batchMessages,
          tools,
          iteration
        });
        if (batch.kind === 'approval') {
          await this.record(runId, 'run.awaiting_approval', {
            pendingApproval: batch.result.pendingApproval
          });
          yield { type: 'result', result: batch.result };
          return;
        }

        messages = [...batchMessages, ...batch.toolMessages];
        iteration += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.record(runId, 'llm.planner.failed', { message });
      const failed = agentResultSchema.parse({
        runId,
        mode: detection.mode,
        status: 'failed',
        summary: `模型请求失败：${message}`,
        report: {
          changedFiles: [],
          evidence: [`LLM 请求失败: ${message}`],
          risks: ['请检查模型名称、baseUrl、鉴权方式或网络连通性']
        }
      });
      await this.record(runId, 'review.completed', {
        status: failed.status,
        summary: failed.summary
      });
      await this.record(runId, 'run.completed', { ...failed });
      yield { type: 'result', result: failed };
      return;
    }

    const plan = createPlan(input.input, detection.mode, fullText);
    await this.record(runId, 'plan.created', plan);

    const result = agentResultSchema.parse({
      runId,
      mode: detection.mode,
      status: 'completed',
      summary: fullText,
      report: {
        changedFiles: [],
        evidence: ['planner LLM 已返回计划建议', '已记录普通任务 trace'],
        risks: []
      }
    });

    await this.record(runId, 'review.completed', {
      status: result.status,
      summary: result.summary
    });
    await this.record(runId, 'run.completed', { ...result });
    this.appendConversation(input.input, result.summary);

    yield { type: 'result', result };
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

    // 先把被打断的这一批 tool_calls 跑完，保证每个 tool_use 都有 tool_result 回填。
    const batch = await this.executeToolBatch({
      runId: session.runId,
      mode: session.mode,
      calls: session.remainingCalls,
      completedToolMessages: [...session.completedToolMessages, toolMessage],
      messages: session.messages,
      tools: session.tools,
      iteration: session.iteration
    });
    if (batch.kind === 'approval') {
      await this.record(session.runId, 'run.awaiting_approval', {
        pendingApproval: batch.result.pendingApproval
      });
      return batch.result;
    }

    const messages: LlmMessage[] = [...session.messages, ...batch.toolMessages];
    const response = await this.completeToolFollowup({
      runId: session.runId,
      messages,
      tools: session.tools,
      iteration: session.iteration,
      metadata: { approvalResolved: input.approved }
    });
    const outcome = await this.runToolLoop({
      runId: session.runId,
      mode: session.mode,
      response,
      messages,
      tools: session.tools,
      iteration: session.iteration + 1
    });
    if (outcome.kind === 'approval') {
      await this.record(session.runId, 'run.awaiting_approval', {
        pendingApproval: outcome.result.pendingApproval
      });
      return outcome.result;
    }

    const result = agentResultSchema.parse({
      runId: session.runId,
      mode: session.mode,
      status: 'completed',
      summary: outcome.response.text,
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
        return this.runToolLoop({
          runId,
          mode,
          response,
          messages: context.messages,
          tools: availableTools,
          iteration: 1
        });
      }

      return { kind: 'response', response };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.record(runId, 'llm.planner.failed', {
        message
      });
      return { kind: 'failure', message };
    }
  }

  /**
   * 工具调用主循环：执行当前 response 里的 tool_calls，把结果回填给模型，
   * 直到模型返回纯文本或达到迭代上限。任何一轮里需要审批的调用都会暂停并
   * 保存会话，等待 resolveToolApproval 恢复。
   */
  private async runToolLoop(input: {
    runId: string;
    mode: Exclude<AgentMode, 'auto'>;
    response: LlmResponse;
    messages: LlmMessage[];
    tools: ToolMetadata[];
    iteration: number;
  }): Promise<ToolLoopOutcome> {
    const maxIterations = this.options.maxToolIterations ?? 4;
    let response = input.response;
    let messages = input.messages;
    let iteration = input.iteration;

    while (response.toolCalls?.length && iteration <= maxIterations) {
      await this.record(input.runId, 'llm.tool_calls.received', {
        count: response.toolCalls.length,
        iteration,
        calls: response.toolCalls.map((call) => ({
          id: call.id,
          name: call.name
        }))
      });

      const assistantMessage: LlmMessage = {
        role: 'assistant',
        content: response.text,
        toolCalls: response.toolCalls
      };
      const batchMessages: LlmMessage[] = [...messages, assistantMessage];
      const batch = await this.executeToolBatch({
        runId: input.runId,
        mode: input.mode,
        calls: response.toolCalls,
        completedToolMessages: [],
        messages: batchMessages,
        tools: input.tools,
        iteration
      });
      if (batch.kind === 'approval') {
        return batch;
      }

      messages = [...batchMessages, ...batch.toolMessages];
      response = await this.completeToolFollowup({
        runId: input.runId,
        messages,
        tools: input.tools,
        iteration
      });
      iteration += 1;
    }

    return { kind: 'response', response };
  }

  /**
   * 顺序执行一批 tool_calls。遇到需要审批的调用时保存会话（包含已完成的
   * tool 消息和剩余调用），返回 approval，保证恢复后同一批调用不缺不重。
   */
  private async executeToolBatch(input: {
    runId: string;
    mode: Exclude<AgentMode, 'auto'>;
    calls: LlmToolCall[];
    completedToolMessages: LlmMessage[];
    messages: LlmMessage[];
    tools: ToolMetadata[];
    iteration: number;
  }): Promise<ToolBatchOutcome> {
    const toolMessages: LlmMessage[] = [...input.completedToolMessages];
    const queue = [...input.calls];

    while (queue.length > 0) {
      const call = queue.shift();
      if (!call) {
        break;
      }

      let result: ToolResult;
      try {
        result = await this.toolGateway!.call({
          runId: input.runId,
          name: call.name,
          input: call.input,
          returnErrors: true
        });
      } catch (error) {
        if (error instanceof ToolPermissionError) {
          // 策略直接 deny 时，不打断成人工审批，而是把拒绝结果回填给模型。
          if (error.action === 'deny') {
            const deniedContent = `Tool ${call.name} denied by policy: ${error.reason ?? error.message}`;
            this.contextManager.recordToolResult({
              id: call.id,
              toolName: call.name,
              inputPreview: JSON.stringify(call.input).slice(0, 200),
              output: deniedContent,
              summary: `denied: ${error.reason ?? error.risk}`
            });
            toolMessages.push({
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              content: deniedContent
            });
            continue;
          }

          const session: PendingToolSession = {
            runId: input.runId,
            mode: input.mode,
            call,
            remainingCalls: queue,
            completedToolMessages: toolMessages,
            messages: input.messages,
            tools: input.tools,
            iteration: input.iteration
          };
          return {
            kind: 'approval',
            result: this.createPendingToolApprovalResult(session, error)
          };
        }
        throw error;
      }

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

    return { kind: 'completed', toolMessages };
  }

  private async completeToolFollowup(input: {
    runId: string;
    messages: LlmMessage[];
    tools: ToolMetadata[];
    iteration: number;
    metadata?: Record<string, unknown>;
  }): Promise<LlmResponse> {
    const response = await this.options.llmClient!.complete({
      messages: input.messages,
      tools: toLlmTools(input.tools),
      maxTokens: 800,
      temperature: 0.2,
      metadata: {
        purpose: 'planner-tool-followup',
        iteration: input.iteration,
        ...input.metadata
      }
    });

    await this.record(input.runId, 'llm.tool_followup.completed', {
      provider: response.provider,
      model: response.model,
      textPreview: response.text.slice(0, 240),
      usage: response.usage,
      toolCallCount: response.toolCalls?.length ?? 0,
      iteration: input.iteration
    });

    return response;
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
