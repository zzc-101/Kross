import { EventEmitter } from 'node:events';

import {
  type AgentMode,
  type AgentResult,
  type TraceEvent,
  agentResultSchema
} from '../domain';
import type { LlmClient, LlmResponse } from '../llm/types';
import { detectMode } from '../modes/modeDetector';
import type { TraceStore } from '../trace/traceStore';

export interface AgentRuntimeOptions {
  traceStore: TraceStore;
  llmClient?: LlmClient;
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

export type AgentRuntimeEvent = TraceEvent;

export class AgentRuntime extends EventEmitter {
  private readonly createRunId: () => string;
  private readonly now: () => Date;

  constructor(private readonly options: AgentRuntimeOptions) {
    super();
    this.createRunId =
      options.createRunId ?? (() => `run-${Date.now().toString(36)}`);
    this.now = options.now ?? (() => new Date());
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

    return result;
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
      const response = await this.options.llmClient.complete({
        messages: [
          {
            role: 'system',
            content:
              '你是本地 agent 的规划器。请基于模式和用户目标给出简短、可执行的计划，不要执行工具。'
          },
          {
            role: 'user',
            content: `模式：${mode}\n用户目标：${goal}`
          }
        ],
        maxTokens: 800,
        temperature: 0.2,
        metadata: {
          purpose: 'planner'
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
