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
  aggregateConductorVerification,
  formatConductorReviewSummary,
  formatConductorTaskPlanSummary,
  parseConductorReviewVerdict,
  parseConductorTaskPlanFromText,
  type ConductorTaskOutcome,
  type ConductorTaskPlan,
  type ConductorValidationOutcome
} from './conductorOrchestration';
import {
  buildConductorValidationTargets,
  CONDUCTOR_MAX_CONCURRENCY,
  executeConductorValidation,
  executeConductorWorker,
  failedWorkerOutcome,
  type ValidationExecutionCompletion,
  type WorkerExecutionCompletion
} from './conductorExecution';
import type {
  AgentRunInput,
  AgentRunStreamEvent,
  AgentRuntimeOptions
} from './agentRuntimeTypes';
import type { ModelSession } from './modelSession';
import type { SessionServices } from './sessionServices';
import { requiresVerificationForFiles } from '../verification';

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
    const taskOutcomesById = new Map<string, ConductorTaskOutcome>();
    const pendingTasks = new Map(plan.tasks.map((task) => [task.id, task]));
    const runningTasks = new Map<
      string,
      Promise<WorkerExecutionCompletion>
    >();

    while (pendingTasks.size > 0 || runningTasks.size > 0) {
      throwIfAborted(signal);
      for (const task of [...pendingTasks.values()]) {
        const dependencies = task.dependsOn ?? [];
        const failedDependency = dependencies.find((dependency) => {
          const outcome = taskOutcomesById.get(dependency);
          return outcome !== undefined && !dependencyOutcomeSucceeded(outcome);
        });
        if (!failedDependency) continue;
        const message = `依赖任务 ${failedDependency} 未成功，已跳过 ${task.id}`;
        const blocked = failedWorkerOutcome(task, message);
        taskOutcomesById.set(task.id, blocked);
        pendingTasks.delete(task.id);
        await this.deps.record(runId, 'conductor.worker.blocked', {
          taskId: task.id,
          dependency: failedDependency,
          reason: message
        });
        yield { type: 'text-delta', text: `\n▸ ${message}\n` };
      }

      while (runningTasks.size < CONDUCTOR_MAX_CONCURRENCY) {
        const task = [...pendingTasks.values()].find((candidate) =>
          (candidate.dependsOn ?? []).every((dependency) =>
            taskOutcomesById.has(dependency)
          )
        );
        if (!task) break;
        pendingTasks.delete(task.id);
        yield {
          type: 'text-delta',
          text: `\n\n▸ Worker 执行任务 [${task.id}] ${task.title}…\n`
        };
        const workspaceRoot = task.repoId
          ? roots?.resolveById(task.repoId)
          : undefined;
        runningTasks.set(
          task.id,
          executeConductorWorker({
            task,
            goal,
            runId,
            signal,
            workspaceRoot,
            runSubagent,
            seniorClient,
            record: this.deps.record
          })
        );
      }

      if (runningTasks.size === 0) {
        for (const task of pendingTasks.values()) {
          taskOutcomesById.set(
            task.id,
            failedWorkerOutcome(task, '任务依赖图无法继续调度')
          );
        }
        pendingTasks.clear();
        break;
      }

      const completed = await Promise.race(runningTasks.values());
      runningTasks.delete(completed.task.id);
      if (completed.abortError) {
        await Promise.allSettled(runningTasks.values());
        throw completed.abortError;
      }
      taskOutcomesById.set(completed.task.id, completed.outcome);
      yield {
        type: 'text-delta',
        text: `  → ${completed.outcome.status}: ${completed.outcome.summary.slice(0, 300)}\n`
      };
    }

    const taskOutcomes = plan.tasks.map(
      (task) =>
        taskOutcomesById.get(task.id) ??
        failedWorkerOutcome(task, '任务未产生执行结果')
    );
    const allChanged = taskOutcomes.flatMap((outcome) =>
      outcome.changedFiles.map((file) => `${outcome.taskId}:${file}`)
    );
    const allEvidence = taskOutcomes.map(
      (outcome) =>
        `${outcome.taskId}: ${outcome.status} · attempts=${outcome.attempts ?? 1} · verification=${outcome.verification.status} — ${outcome.summary.slice(0, 200)}`
    );
    const allRisks = taskOutcomes.flatMap((outcome) =>
      outcome.risks.map((risk) => `${outcome.taskId}: ${risk}`)
    );

    const validationTargets = buildConductorValidationTargets(taskOutcomes);
    const validationOutcomes: ConductorValidationOutcome[] = [];
    if (validationTargets.length > 0) {
      await this.deps.record(runId, 'conductor.validation.started', {
        roots: validationTargets.map((target) => target.repoId ?? 'primary')
      });
      for (const target of validationTargets) {
        yield {
          type: 'text-delta',
          text: `\n▸ Validation worker 验证最终工作树 [${target.repoId ?? 'primary'}]…\n`
        };
      }
      const settledValidations: ValidationExecutionCompletion[] = [];
      for (
        let index = 0;
        index < validationTargets.length;
        index += CONDUCTOR_MAX_CONCURRENCY
      ) {
        const batch = validationTargets.slice(
          index,
          index + CONDUCTOR_MAX_CONCURRENCY
        );
        settledValidations.push(
          ...(await Promise.all(
            batch.map((target) =>
              executeConductorValidation({
                target,
                goal,
                runId,
                signal,
                workspaceRoot: target.repoId
                  ? roots?.resolveById(target.repoId)
                  : this.deps.options.workspaceRoot,
                runSubagent
              })
            )
          ))
        );
      }
      for (const validation of settledValidations) {
        if (validation.abortError) throw validation.abortError;
        validationOutcomes.push(validation.outcome);
        allEvidence.push(
          `validation(${validation.outcome.repoId ?? 'primary'}): ${validation.outcome.verification.status} — ${validation.outcome.summary.slice(0, 200)}`
        );
        allRisks.push(
          ...validation.outcome.risks.map(
            (risk) => `validation(${validation.outcome.repoId ?? 'primary'}): ${risk}`
          )
        );
        yield {
          type: 'text-delta',
          text: `  → validation ${validation.outcome.verification.status}: ${validation.outcome.summary.slice(0, 240)}\n`
        };
        await this.deps.record(runId, 'conductor.validation.evidence', {
          root: validation.outcome.repoId ?? 'primary',
          status: validation.outcome.status,
          verification: validation.outcome.verification,
          evidence: validation.outcome.evidence
        });
      }
      await this.deps.record(runId, 'conductor.validation.completed', {
        roots: validationOutcomes.map(
          (validation) => validation.repoId ?? 'primary'
        ),
        statuses: validationOutcomes.map(
          (validation) => validation.verification.status
        )
      });
    }

    yield { type: 'text-delta', text: '\n### 高级模型验收\n\n' };
    const workerDigest = taskOutcomes
      .map(
        (outcome) =>
          `### ${outcome.taskId} ${outcome.title} [${outcome.status}]\n${outcome.summary}\nfiles=${outcome.changedFiles.join(', ') || '—'}\nverification=${outcome.verification.status}\ncommands=${outcome.verification.commands.join(', ') || '—'}\nevidence=${outcome.evidence.join('; ') || '—'}\nneedsReview=${outcome.needsReview.join('; ') || '—'}\nrisks=${outcome.risks.join('; ') || '—'}`
      )
      .join('\n\n');
    const validationDigest = validationOutcomes
      .map(
        (validation) =>
          `### validation ${validation.repoId ?? 'primary'} [${validation.status}]\n${validation.summary}\nverification=${validation.verification.status}\ncommands=${validation.verification.commands.join(', ') || '—'}\nevidence=${validation.verification.evidence.join('; ') || '—'}\nrisks=${validation.risks.join('; ') || '—'}`
      )
      .join('\n\n');
    const digest = [workerDigest, validationDigest]
      .filter((section) => section.length > 0)
      .join('\n\n');

    let reviewText = '';
    const reviewerSubRunIds: string[] = [];
    const reviewerEvidence: string[] = [];
    let reviewerIncomplete = !seniorClient;
    let reviewerRejected = false;
    if (!seniorClient) {
      allRisks.push('未配置高级模型，无法执行最终 diff 验收');
    }
    if (seniorClient) {
      const reviewTargets = buildConductorReviewTargets(taskOutcomes);
      await this.deps.record(runId, 'conductor.review.started', {
        roots: reviewTargets.map(
          (target) => target.repoId ?? 'primary'
        )
      });
      const reviewSections: string[] = [];
      for (const target of reviewTargets) {
        throwIfAborted(signal);
        const rootLabel = target.repoId ?? 'primary';
        yield {
          type: 'text-delta',
          text: `▸ Reviewer 检查最终 diff [${rootLabel}]…\n`
        };
        try {
          const reviewer = await runSubagent({
            prompt: renderPrompt('conductor.review.user', {
              goal,
              digest,
              rootLabel,
              changedFiles: target.changedFiles.join(', ') || '—'
            }),
            title: `验收 ${rootLabel}`.slice(0, 48),
            mode: 'explore',
            role: 'reviewer',
            systemPrompt: renderModePhasePrompt(
              'conductor.review',
              'conductor'
            ),
            parentRunId: runId,
            parentDepth: 0,
            signal,
            repoId: target.repoId,
            workspaceRoot: target.repoId
              ? roots?.resolveById(target.repoId)
              : this.deps.options.workspaceRoot,
            preferWorkerModel: false
          });
          reviewerSubRunIds.push(reviewer.subRunId);
          const reviewerResult = reviewer.result;
          reviewerEvidence.push(
            `${rootLabel}: ${reviewerResult.status} — ${reviewerResult.summary.slice(0, 240)}`,
            ...reviewerResult.evidence.map(
              (item) => `${rootLabel}: ${item}`
            )
          );
          const verdict = parseConductorReviewVerdict(
            reviewerResult.summary
          );
          await this.deps.record(runId, 'conductor.review.evidence', {
            root: rootLabel,
            subRunId: reviewer.subRunId,
            status: reviewerResult.status,
            summaryPreview: reviewerResult.summary.slice(0, 400),
            evidenceCount: reviewerResult.evidence.length,
            toolsUsed: reviewerResult.toolsUsed,
            verdict
          });
          const inspectedStatus = reviewerResult.toolsUsed.includes('GitStatus');
          const inspectedUnstagedDiff = reviewerResult.toolsUsed.includes(
            'GitDiff:unstaged'
          );
          const inspectedStagedDiff = reviewerResult.toolsUsed.includes(
            'GitDiff:staged'
          );
          if (
            reviewerResult.status === 'completed' &&
            reviewerResult.summary.trim().length > 0 &&
            inspectedStatus &&
            inspectedUnstagedDiff &&
            inspectedStagedDiff &&
            verdict !== undefined
          ) {
            reviewSections.push(
              `#### ${rootLabel}\n${reviewerResult.summary.trim()}`
            );
            if (verdict === 'needs-work') {
              reviewerRejected = true;
              allRisks.push(`${rootLabel}: reviewer verdict=NEEDS_WORK`);
            }
          } else {
            reviewerIncomplete = true;
            const missingTools = [
              inspectedStatus ? undefined : 'GitStatus',
              inspectedUnstagedDiff ? undefined : 'GitDiff(unstaged)',
              inspectedStagedDiff ? undefined : 'GitDiff(staged)',
              verdict !== undefined ? undefined : 'VERDICT'
            ].filter((tool): tool is string => tool !== undefined);
            allRisks.push(
              `${rootLabel}: reviewer 未能完成只读验收` +
                (missingTools.length > 0
                  ? `，缺少工具证据：${missingTools.join(', ')}`
                  : '')
            );
          }
        } catch (error) {
          if (isOperationAborted(error, signal)) {
            throw error;
          }
          const message = error instanceof Error ? error.message : String(error);
          reviewerIncomplete = true;
          reviewerEvidence.push(`${rootLabel}: reviewer failed — ${message}`);
          allRisks.push(`${rootLabel}: reviewer failed — ${message}`);
        }
      }
      reviewText = reviewSections.join('\n\n');
    }
    if (!reviewText.trim() && seniorClient) {
      for await (const event of this.streamPlainAssistantText({
        systemPrompt: renderModePhasePrompt('conductor.review', 'conductor'),
        userText: renderPrompt('conductor.review.user', {
          goal,
          digest,
          rootLabel: 'primary',
          changedFiles:
            taskOutcomes
              .flatMap((outcome) => outcome.changedFiles)
              .join(', ') || '—'
        }),
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
      reviewPreview: reviewText.slice(0, 400),
      reviewerSubRunIds,
      reviewerEvidenceCount: reviewerEvidence.length,
      reviewerIncomplete,
      reviewerRejected
    });
    const summary = formatConductorReviewSummary({ goal, taskOutcomes, reviewText });
    const workerVerification = aggregateConductorVerification(
      taskOutcomes,
      validationOutcomes
    );
    const verificationRequired = taskOutcomes.some((outcome) =>
      requiresVerificationForFiles(outcome.changedFiles)
    );
    const anyFailed =
      reviewerIncomplete ||
      reviewerRejected ||
      (verificationRequired && workerVerification.status !== 'passed') ||
      validationOutcomes.some(
        (validation) => validation.status !== 'completed'
      ) ||
      taskOutcomes.some(
        (outcome) => outcome.status === 'failed' || outcome.executionIncomplete
      );
    const currentSenior = this.deps.modelSession.getLlmClient();
    const attached = await this.deps.attachChangedFiles(
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
            ...allEvidence,
            ...reviewerEvidence
          ],
          risks: allRisks
        }
      })
    );
    const result = agentResultSchema.parse({
      ...attached,
      report: {
        ...attached.report,
        verification: workerVerification,
        evidence: [
          ...attached.report.evidence,
          `worker-verification=${workerVerification.status}`
        ]
      }
    });

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

function buildConductorReviewTargets(
  outcomes: ConductorTaskOutcome[]
): Array<{ repoId?: string; changedFiles: string[] }> {
  const byRoot = new Map<
    string,
    { repoId?: string; changedFiles: Set<string> }
  >();
  for (const outcome of outcomes) {
    const key = outcome.repoId ?? '__primary__';
    const target = byRoot.get(key) ?? {
      repoId: outcome.repoId,
      changedFiles: new Set<string>()
    };
    for (const file of outcome.changedFiles) {
      target.changedFiles.add(file);
    }
    byRoot.set(key, target);
  }
  if (byRoot.size === 0) {
    return [{ changedFiles: [] }];
  }
  return [...byRoot.values()].map((target) => ({
    repoId: target.repoId,
    changedFiles: [...target.changedFiles].sort()
  }));
}

function dependencyOutcomeSucceeded(outcome: ConductorTaskOutcome): boolean {
  return (
    (outcome.status === 'completed' &&
      outcome.verification.status !== 'failed') ||
    (outcome.status === 'needs-review' &&
      outcome.executionIncomplete !== true &&
      outcome.verification.status !== 'failed' &&
      outcome.changedFiles.length > 0)
  );
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
