import { EventEmitter } from 'node:events';

import {
  type AgentMode,
  type AgentResult,
  type TraceEvent,
  agentResultSchema
} from '../domain';
import {
  InMemoryContextManager,
  type ContextManager,
  type ContextSnapshot
} from '../context/contextManager';
import type { LlmClient, LlmResponse } from '../llm/types';
import { detectMode } from '../modes/modeDetector';
import { ToolGateway } from '../tools/toolGateway';
import type { TraceStore } from '../trace/traceStore';

export interface AgentRuntimeOptions {
  traceStore: TraceStore;
  llmClient?: LlmClient;
  contextManager?: ContextManager;
  toolGateway?: ToolGateway;
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

export interface ContextInspectionInput {
  requestedMode: AgentMode;
  currentUserInput?: string;
}

export interface ContextInspection extends ContextSnapshot {
  mode: Exclude<AgentMode, 'auto'>;
}

export type AgentRuntimeEvent = TraceEvent;

const PLANNER_SYSTEM_PROMPT =
  '你是本地 agent 的规划器。请基于模式和用户目标给出简短、可执行的计划。需要工具时，只能基于可用工具清单提出调用意图，不要编造工具。';

export class AgentRuntime extends EventEmitter {
  private readonly createRunId: () => string;
  private readonly now: () => Date;
  private readonly contextManager: ContextManager;
  private readonly toolGateway: ToolGateway | undefined;

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

    const plannerSuggestion = await this.createPlannerSuggestion(
      runId,
      input.input,
      detection.mode
    );

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
      tools: this.toolGateway?.listTools() ?? []
    });

    return {
      ...snapshot,
      mode
    };
  }

  private async createPlannerSuggestion(
    runId: string,
    goal: string,
    mode: Exclude<AgentMode, 'auto'>
  ): Promise<LlmResponse | undefined> {
    if (!this.options.llmClient) {
      return undefined;
    }

    try {
      const context = this.contextManager.build({
        systemPrompt: PLANNER_SYSTEM_PROMPT,
        currentUserInput: goal,
        mode,
        tools: this.toolGateway?.listTools() ?? []
      });

      await this.record(runId, 'context.built', {
        includedSources: context.includedSources,
        droppedSources: context.droppedSources,
        estimatedChars: context.estimatedChars,
        report: context.report
      });

      const response = await this.options.llmClient.complete({
        messages: context.messages,
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
        usage: response.usage
      });

      return response;
    } catch (error) {
      await this.record(runId, 'llm.planner.failed', {
        message: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
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
