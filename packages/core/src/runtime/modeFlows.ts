import {
  isOperationAborted,
  throwIfAborted
} from '../abort';
import {
  agentResultSchema,
  type AgentMode,
  type AgentResult
} from '../domain';
import type { PendingConductorExecution } from '../modes/pendingExecution';
import { renderModePhasePrompt, renderPrompt } from '../prompts';
import {
  formatConductorReviewSummary,
  formatConductorTaskPlanSummary,
  parseConductorTaskPlanFromText,
  type ConductorTaskPlan
} from './conductorOrchestration';
import type {
  AgentRunInput,
  AgentRunStreamEvent,
  AgentRuntimeOptions
} from './agentRuntimeTypes';
import type { ModelSession } from './modelSession';
import type { SessionServices } from './sessionServices';

export interface ModeFlowsDeps {
  options: AgentRuntimeOptions;
  modelSession: ModelSession;
  sessionServices: SessionServices;
  record: (
    runId: string,
    type: string,
    payload: Record<string, unknown>
  ) => Promise<void>;
  runAgentToolLoop: (
    input: AgentRunInput,
    mode: AgentMode,
    runId: string,
    options?: { planText?: string }
  ) => AsyncIterable<AgentRunStreamEvent>;
  attachChangedFiles: (result: AgentResult) => Promise<AgentResult>;
  finishTurnWithAssistant: (userInput: string, assistantOutput: string) => void;
}

/** Plan/conductor policy flows. AgentRuntime owns only entry dispatch. */
export class ModeFlows {
  constructor(private readonly deps: ModeFlowsDeps) {}

  async *planGatePhase(
    input: AgentRunInput,
    runId: string,
    reason: string | undefined
  ): AsyncIterable<AgentRunStreamEvent> {
    throwIfAborted(input.signal);
    const intent = await this.classifyPlanIntent(input.input, input.signal);
    await this.deps.record(runId, 'plan.intent', intent);

    if (intent.kind === 'chat') {
      yield* this.deps.runAgentToolLoop(input, 'plan', runId);
      return;
    }

    const header = '【Plan 模式 · 等待确认】\n\n';
    const footer = '\n\n输入 /approve 按该计划开始开发，或 /reject 取消。';
    yield { type: 'text-delta', text: header };

    let planBody = '';
    for await (const event of this.streamPlainAssistantText({
      systemPrompt: renderModePhasePrompt('plan.body', 'plan'),
      userText: input.input,
      signal: input.signal,
      purpose: 'plan-body'
    })) {
      planBody += event.text;
      yield event;
    }

    if (!planBody.trim()) {
      planBody = [
        `目标：${input.input}`,
        '',
        '1. 探索相关代码',
        '2. 实现变更',
        '3. 验证测试'
      ].join('\n');
      yield { type: 'text-delta', text: planBody };
    }

    yield { type: 'text-delta', text: footer };
    const result = await this.finishPlanGateWithText(
      input,
      runId,
      planBody.trim(),
      reason
    );
    yield { type: 'result', result };
  }

  private async classifyPlanIntent(
    userInput: string,
    signal?: AbortSignal
  ): Promise<{ kind: 'chat' | 'plan'; reason: string }> {
    const client = this.deps.modelSession.getLlmClient();
    if (!client) {
      return isCasualChatInput(userInput)
        ? { kind: 'chat', reason: 'no-llm heuristic' }
        : { kind: 'plan', reason: 'no-llm heuristic' };
    }
    throwIfAborted(signal);
    try {
      const response = await client.complete({
        messages: [
          { role: 'system', content: renderPrompt('plan.intent') },
          { role: 'user', content: userInput }
        ],
        maxTokens: 80,
        metadata: { purpose: 'plan-mode-intent', internal: true }
      });
      const kind = parsePlanIntentKind(response.text ?? '');
      if (kind) {
        return kind;
      }
    } catch {
      // fall through to the deterministic fallback
    }
    return isCasualChatInput(userInput)
      ? { kind: 'chat', reason: 'llm-failed heuristic' }
      : { kind: 'plan', reason: 'llm-failed heuristic' };
  }

  private async *streamPlainAssistantText(input: {
    systemPrompt: string;
    userText: string;
    signal?: AbortSignal;
    purpose?: string;
  }): AsyncIterable<Extract<AgentRunStreamEvent, { type: 'text-delta' }>> {
    const client = this.deps.modelSession.getLlmClient();
    if (!client) {
      return;
    }
    throwIfAborted(input.signal);
    for await (const chunk of client.stream({
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userText }
      ],
      signal: input.signal,
      metadata: { purpose: input.purpose ?? 'assistant-stream' }
    })) {
      throwIfAborted(input.signal);
      if (chunk.type === 'text-delta' && chunk.text) {
        yield { type: 'text-delta', text: chunk.text };
      }
    }
  }

  private async finishPlanGateWithText(
    input: AgentRunInput,
    runId: string,
    planText: string,
    reason: string | undefined
  ): Promise<AgentResult> {
    await this.deps.record(runId, 'plan.created', {
      mode: 'plan',
      goal: input.input,
      planText
    });
    await this.deps.record(runId, 'approval.required', {
      scope: 'plan-mode',
      reason
    });

    const summary = [
      '【Plan 模式 · 等待确认】',
      '',
      planText,
      '',
      '输入 /approve 按该计划开始开发，或 /reject 取消。'
    ].join('\n');
    this.deps.sessionServices.setPendingModeExecution({
      kind: 'plan',
      goal: input.input,
      mode: 'plan',
      planText
    });

    const cancelled = await this.deps.attachChangedFiles(
      agentResultSchema.parse({
        runId,
        mode: 'plan',
        status: 'cancelled',
        cancellationReason: 'approval-gate',
        summary,
        report: {
          changedFiles: [],
          evidence: ['plan-first：确认前不改文件'],
          risks: []
        }
      })
    );
    await this.deps.record(runId, 'run.completed', { ...cancelled });
    this.deps.finishTurnWithAssistant(input.input, cancelled.summary);
    return cancelled;
  }

  async *conductorGatePhase(
    input: AgentRunInput,
    runId: string,
    conductorReason: string | undefined
  ): AsyncIterable<AgentRunStreamEvent> {
    throwIfAborted(input.signal);
    this.deps.sessionServices.syncProjectRegistrySource();

    // Internal complete can take time; show visible progress before it starts.
    yield {
      type: 'text-delta',
      text: '【指挥家】正在拆分任务…\n\n'
    };

    const plan = await this.buildConductorTaskPlan(input.input, input.signal);
    const summary = formatConductorTaskPlanSummary(plan);
    for (const chunk of chunkTextForStream(summary)) {
      throwIfAborted(input.signal);
      yield { type: 'text-delta', text: chunk };
    }

    await this.deps.record(runId, 'plan.created', {
      mode: 'conductor',
      goal: plan.goal,
      tasks: plan.tasks,
      notes: plan.notes
    });
    await this.deps.record(runId, 'approval.required', {
      scope: 'conductor-plan',
      reason: conductorReason,
      taskIds: plan.tasks.map((task) => task.id)
    });
    this.deps.sessionServices.setPendingModeExecution({
      kind: 'conductor',
      goal: input.input,
      mode: 'conductor',
      plan
    });

    const cancelled = await this.deps.attachChangedFiles(
      agentResultSchema.parse({
        runId,
        mode: 'conductor',
        status: 'cancelled',
        cancellationReason: 'approval-gate',
        summary,
        report: {
          changedFiles: [],
          evidence: [
            `tasks=${plan.tasks.map((task) => task.id).join(',')}`,
            '指挥家策略：高级模型规划 → worker 执行 → 高级模型验收',
            '多目录是 /add-dir，与 mode 正交'
          ],
          risks: []
        }
      })
    );
    await this.deps.record(runId, 'run.completed', { ...cancelled });
    this.deps.finishTurnWithAssistant(input.input, cancelled.summary);
    yield { type: 'result', result: cancelled };
  }

  private async buildConductorTaskPlan(
    goal: string,
    signal?: AbortSignal
  ): Promise<ConductorTaskPlan> {
    const client = this.deps.modelSession.getLlmClient();
    if (!client) {
      return parseConductorTaskPlanFromText(goal, '');
    }
    throwIfAborted(signal);
    const rootsHint = this.deps.options.workspaceRoots
      ? this.deps.options.workspaceRoots.formatForPrompt()
      : '（仅主工作区；可用 /add-dir 增加目录，并在任务里填 repoId）';
    try {
      const response = await client.complete({
        messages: [
          {
            role: 'system',
            content: renderModePhasePrompt('conductor.plan', 'conductor')
          },
          {
            role: 'user',
            content: renderPrompt('conductor.plan.user', { goal, rootsHint })
          }
        ],
        metadata: { purpose: 'conductor-plan', internal: true }
      });
      return parseConductorTaskPlanFromText(goal, response.text ?? '');
    } catch {
      return parseConductorTaskPlanFromText(goal, '');
    }
  }

  async *conductorExecutePhase(
    runId: string,
    pending: PendingConductorExecution,
    signal?: AbortSignal
  ): AsyncIterable<AgentRunStreamEvent> {
    throwIfAborted(signal);
    const { plan, goal } = pending;
    const mode = 'conductor' as const;
    const seniorClient = this.deps.modelSession.getLlmClient();
    const missingRootIds = [
      ...new Set(
        plan.tasks
          .map((task) => task.repoId)
          .filter(
            (repoId): repoId is string =>
              Boolean(repoId) &&
              !this.deps.options.workspaceRoots?.resolveById(repoId!)
          )
      )
    ];
    if (missingRootIds.length > 0) {
      const message =
        `指挥家计划引用了当前会话中不存在的 workspace root：${missingRootIds.join(', ')}。` +
        '请先用 /add-dir 恢复这些目录，再次 /approve；计划尚未执行。';
      yield { type: 'text-delta', text: message };
      const blocked = await this.deps.attachChangedFiles(
        agentResultSchema.parse({
          runId,
          mode,
          status: 'cancelled',
          cancellationReason: 'missing-workspace-root',
          summary: message,
          report: {
            changedFiles: [],
            evidence: ['恢复后的 conductor plan 已重新校验 workspace roots'],
            risks: missingRootIds.map((id) => `缺失 workspace root: ${id}`)
          }
        })
      );
      await this.deps.record(runId, 'run.completed', { ...blocked });
      this.deps.finishTurnWithAssistant(goal, blocked.summary);
      yield { type: 'result', result: blocked };
      return;
    }

    await this.deps.record(runId, 'conductor.execution.started', {
      taskIds: plan.tasks.map((task) => task.id),
      workerModel: this.deps.options.workerLlmClient?.model,
      seniorModel: seniorClient?.model
    });

    const runSubagent = this.deps.options.runSubagent;
    if (!runSubagent) {
      const message =
        '指挥家计划已确认，但运行时未注入 runSubagent，无法派生 worker 子代理。';
      yield { type: 'text-delta', text: message };
      const failed = await this.deps.attachChangedFiles(
        agentResultSchema.parse({
          runId,
          mode,
          status: 'failed',
          summary: message,
          report: {
            changedFiles: [],
            evidence: ['缺少 AgentRuntimeOptions.runSubagent'],
            risks: []
          }
        })
      );
      await this.deps.record(runId, 'run.completed', { ...failed });
      this.deps.sessionServices.clearPendingModeExecution();
      this.deps.finishTurnWithAssistant(goal, failed.summary);
      yield { type: 'result', result: failed };
      return;
    }

    const roots = this.deps.options.workspaceRoots;
    const taskOutcomes: Array<{
      taskId: string;
      title: string;
      status: string;
      summary: string;
      changedFiles: string[];
      risks: string[];
    }> = [];
    const allChanged: string[] = [];
    const allEvidence: string[] = [];
    const allRisks: string[] = [];

    for (const task of plan.tasks) {
      throwIfAborted(signal);
      yield {
        type: 'text-delta',
        text: `\n\n▸ Worker 执行任务 [${task.id}] ${task.title}…\n`
      };
      const workspaceRoot = task.repoId
        ? roots?.resolveById(task.repoId)
        : undefined;
      try {
        const outcome = await runSubagent({
          prompt: task.prompt,
          title: task.title.slice(0, 48),
          mode: 'general',
          parentRunId: runId,
          parentDepth: 0,
          signal,
          repoId: task.repoId,
          workspaceRoot,
          preferWorkerModel: true
        });
        const result = outcome.result;
        taskOutcomes.push({
          taskId: task.id,
          title: task.title,
          status: result.status,
          summary: result.summary,
          changedFiles: result.changedFiles,
          risks: result.risks
        });
        yield {
          type: 'text-delta',
          text: `  → ${result.status}: ${result.summary.slice(0, 300)}\n`
        };
        for (const file of result.changedFiles) {
          allChanged.push(`${task.id}:${file}`);
        }
        allEvidence.push(
          `${task.id}: ${result.status} — ${result.summary.slice(0, 200)}`
        );
        allRisks.push(...result.risks.map((risk) => `${task.id}: ${risk}`));
      } catch (error) {
        if (isOperationAborted(error, signal)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        taskOutcomes.push({
          taskId: task.id,
          title: task.title,
          status: 'failed',
          summary: message,
          changedFiles: [],
          risks: [message]
        });
        yield { type: 'text-delta', text: `  → failed: ${message}\n` };
        allEvidence.push(`${task.id}: failed — ${message}`);
        allRisks.push(`${task.id}: ${message}`);
      }
    }

    yield { type: 'text-delta', text: '\n### 高级模型验收\n\n' };
    const digest = taskOutcomes
      .map(
        (outcome) =>
          `### ${outcome.taskId} ${outcome.title} [${outcome.status}]\n${outcome.summary}\nfiles=${outcome.changedFiles.join(', ') || '—'}\nrisks=${outcome.risks.join('; ') || '—'}`
      )
      .join('\n\n');

    let reviewText = '';
    if (seniorClient) {
      for await (const event of this.streamPlainAssistantText({
        systemPrompt: renderModePhasePrompt('conductor.review', 'conductor'),
        userText: renderPrompt('conductor.review.user', { goal, digest }),
        signal,
        purpose: 'conductor-review'
      })) {
        reviewText += event.text;
        yield event;
      }
    }
    if (!reviewText.trim()) {
      reviewText = [
        '（无高级模型流式验收）',
        `共 ${taskOutcomes.length} 个子任务，失败 ${taskOutcomes.filter((outcome) => outcome.status === 'failed').length} 个。`
      ].join('\n');
      yield { type: 'text-delta', text: reviewText };
    }

    await this.deps.record(runId, 'conductor.review.completed', {
      taskCount: taskOutcomes.length,
      reviewPreview: reviewText.slice(0, 400)
    });
    const summary = formatConductorReviewSummary({ goal, taskOutcomes, reviewText });
    const anyFailed = taskOutcomes.some((outcome) => outcome.status === 'failed');
    const currentSenior = this.deps.modelSession.getLlmClient();
    const result = await this.deps.attachChangedFiles(
      agentResultSchema.parse({
        runId,
        mode,
        status: anyFailed ? 'failed' : 'completed',
        summary,
        report: {
          changedFiles: allChanged,
          evidence: [
            `senior=${currentSenior?.model ?? 'n/a'}`,
            `worker=${this.deps.options.workerLlmClient?.model ?? currentSenior?.model ?? 'n/a'}`,
            ...allEvidence
          ],
          risks: allRisks
        }
      })
    );

    await this.deps.record(runId, 'review.completed', {
      status: result.status,
      summary: result.summary,
      tasks: taskOutcomes.map((outcome) => ({
        id: outcome.taskId,
        status: outcome.status
      }))
    });
    await this.deps.record(runId, 'run.completed', { ...result });
    this.deps.sessionServices.clearPendingModeExecution();
    this.deps.finishTurnWithAssistant(goal, result.summary);
    yield { type: 'result', result };
  }
}

/** No-model fallback for deciding whether plan mode should chat or plan. */
export function isCasualChatInput(input: string): boolean {
  const text = input.trim();
  if (text.length === 0) return true;
  if (text.length > 40) return false;
  return /^(你好|您好|嗨|哈喽|在吗|在不在|早上好|中午好|下午好|晚上好|谢谢|感谢|再见|拜拜|ok|okay|好的|嗯|hi|hello|hey|thanks|thank you|bye)([\s!！.。?？~～❤️🙏]*)$/i.test(
    text
  );
}

/** Split formatted content into text-deltas without changing stored summaries. */
export function chunkTextForStream(text: string, chunkSize = 64): string[] {
  if (!text) {
    return [];
  }
  if (chunkSize <= 0 || text.length <= chunkSize) {
    return [text];
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    chunks.push(text.slice(offset, offset + chunkSize));
  }
  return chunks;
}

/** Parse internal plan-intent JSON without exposing it as assistant output. */
export function parsePlanIntentKind(
  raw: string
): { kind: 'chat' | 'plan'; reason: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  try {
    const obj = JSON.parse(candidate) as Record<string, unknown>;
    const kind = typeof obj.kind === 'string' ? obj.kind.toLowerCase() : '';
    const reason =
      typeof obj.reason === 'string' && obj.reason.trim()
        ? obj.reason.trim()
        : 'model';
    if (kind === 'chat' || kind === 'plan') return { kind, reason };
  } catch {
    // fall through to permissive parsing
  }
  if (/\bkind\b["']?\s*[:=]\s*["']?chat/i.test(trimmed)) {
    return { kind: 'chat', reason: 'regex' };
  }
  if (/\bkind\b["']?\s*[:=]\s*["']?plan/i.test(trimmed)) {
    return { kind: 'plan', reason: 'regex' };
  }
  return undefined;
}
