import { isOperationAborted } from '../abort';
import type { VerificationReport } from '../domain';
import type { LlmClient } from '../llm/types';
import { renderPrompt } from '../prompts';
import { requiresVerificationForFiles } from '../verification';
import {
  parseReplannedConductorTask,
  type ConductorTask,
  type ConductorTaskOutcome,
  type ConductorValidationOutcome
} from './conductorOrchestration';
import type { SubagentRunner } from './subagentTypes';

export const CONDUCTOR_MAX_CONCURRENCY = 3;
const CONDUCTOR_WORKER_MAX_ATTEMPTS = 2;

export interface WorkerExecutionCompletion {
  task: ConductorTask;
  outcome: ConductorTaskOutcome;
  abortError?: unknown;
}

export interface ConductorValidationTarget {
  repoId?: string;
  changedFiles: string[];
  verificationDigest: string;
}

export interface ValidationExecutionCompletion {
  outcome: ConductorValidationOutcome;
  abortError?: unknown;
}

export async function executeConductorWorker(input: {
  task: ConductorTask;
  goal: string;
  runId: string;
  signal?: AbortSignal;
  workspaceRoot?: string;
  runSubagent: SubagentRunner;
  seniorClient?: LlmClient;
  record: (
    runId: string,
    type: string,
    payload: Record<string, unknown>
  ) => Promise<void>;
}): Promise<WorkerExecutionCompletion> {
  const history: string[] = [];
  let lastOutcome = failedWorkerOutcome(input.task, 'Worker 未开始执行');

  const runAttempt = async (
    task: ConductorTask,
    attempt: number,
    recovery?: 'retry' | 'replan'
  ): Promise<ConductorTaskOutcome> => {
    await input.record(input.runId, 'conductor.worker.attempt.started', {
      taskId: input.task.id,
      attempt,
      recovery
    });
    try {
      const spawned = await input.runSubagent({
        prompt:
          recovery === 'retry' && history.length > 0
            ? `${task.prompt}\n\nConductor retry context:\n${history.at(-1)}\nDo not repeat the same failed approach.`
            : task.prompt,
        title: task.title.slice(0, 48),
        mode: 'general',
        role: 'worker',
        parentRunId: input.runId,
        parentDepth: 0,
        signal: input.signal,
        repoId: task.repoId,
        workspaceRoot: input.workspaceRoot,
        preferWorkerModel: true
      });
      const result = spawned.result;
      const outcome: ConductorTaskOutcome = {
        taskId: input.task.id,
        title: task.title,
        repoId: input.task.repoId,
        status: result.status,
        summary: result.summary,
        changedFiles: result.changedFiles,
        evidence: [...result.evidence, ...history],
        risks: result.risks,
        needsReview: result.needsReview,
        verification: result.verification,
        attempts: attempt,
        recovery,
        retrySafe: result.changedFiles.length === 0,
        executionIncomplete:
          result.status === 'needs-review' &&
          (result.risks.some((risk) => /尚未完成|stalled|阻塞/i.test(risk)) ||
            result.needsReview.some((item) => /阻塞证据|stalled/i.test(item)))
      };
      await input.record(input.runId, 'conductor.worker.attempt.completed', {
        taskId: input.task.id,
        attempt,
        recovery,
        status: outcome.status,
        changedFiles: outcome.changedFiles,
        verification: outcome.verification
      });
      return outcome;
    } catch (error) {
      if (isOperationAborted(error, input.signal)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const outcome = failedWorkerOutcome(task, message);
      outcome.attempts = attempt;
      outcome.recovery = recovery;
      await input.record(input.runId, 'conductor.worker.attempt.completed', {
        taskId: input.task.id,
        attempt,
        recovery,
        status: 'failed',
        error: message
      });
      return outcome;
    }
  };

  try {
    for (
      let attempt = 1;
      attempt <= CONDUCTOR_WORKER_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const recovery = attempt > 1 ? 'retry' : undefined;
      lastOutcome = await runAttempt(input.task, attempt, recovery);
      if (!isRetryableWorkerOutcome(lastOutcome)) {
        return { task: input.task, outcome: lastOutcome };
      }
      history.push(
        `attempt ${attempt} ${lastOutcome.status}: ${lastOutcome.summary.slice(0, 300)}`
      );
      if (attempt < CONDUCTOR_WORKER_MAX_ATTEMPTS) {
        await input.record(input.runId, 'conductor.worker.retry', {
          taskId: input.task.id,
          nextAttempt: attempt + 1,
          reason: lastOutcome.summary.slice(0, 400)
        });
      }
    }

    if (input.seniorClient && isRetryableWorkerOutcome(lastOutcome)) {
      await input.record(input.runId, 'conductor.worker.replan.started', {
        taskId: input.task.id,
        attempts: CONDUCTOR_WORKER_MAX_ATTEMPTS
      });
      let replanned: ConductorTask | undefined;
      try {
        const response = await input.seniorClient.complete({
          messages: [
            { role: 'system', content: renderPrompt('conductor.replan') },
            {
              role: 'user',
              content: renderPrompt('conductor.replan.user', {
                goal: input.goal,
                task: JSON.stringify(input.task),
                failure: history.join('\n')
              })
            }
          ],
          signal: input.signal,
          metadata: { purpose: 'conductor-worker-replan', internal: true }
        });
        replanned = parseReplannedConductorTask(
          input.task,
          response.text ?? ''
        );
      } catch (error) {
        if (isOperationAborted(error, input.signal)) throw error;
        history.push(
          `replan failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      await input.record(input.runId, 'conductor.worker.replan.completed', {
        taskId: input.task.id,
        accepted: Boolean(replanned)
      });
      if (replanned) {
        const outcome = await runAttempt(
          replanned,
          CONDUCTOR_WORKER_MAX_ATTEMPTS + 1,
          'replan'
        );
        return { task: input.task, outcome };
      }
    }

    return {
      task: input.task,
      outcome: {
        ...lastOutcome,
        evidence: [...lastOutcome.evidence, ...history],
        risks: [
          ...lastOutcome.risks,
          'Worker 在有限重试后仍未成功，且未获得可执行的恢复计划'
        ]
      }
    };
  } catch (error) {
    return {
      task: input.task,
      outcome: lastOutcome,
      abortError: error
    };
  }
}

export function buildConductorValidationTargets(
  outcomes: ConductorTaskOutcome[]
): ConductorValidationTarget[] {
  const targets = new Map<
    string,
    {
      repoId?: string;
      changedFiles: Set<string>;
      verification: string[];
      required: boolean;
    }
  >();
  for (const outcome of outcomes) {
    const key = outcome.repoId ?? '__primary__';
    const target = targets.get(key) ?? {
      repoId: outcome.repoId,
      changedFiles: new Set<string>(),
      verification: [],
      required: false
    };
    for (const file of outcome.changedFiles) target.changedFiles.add(file);
    target.verification.push(
      `${outcome.taskId}: ${outcome.verification.status}` +
        (outcome.verification.commands.length > 0
          ? ` (${outcome.verification.commands.join(', ')})`
          : '')
    );
    if (
      requiresVerificationForFiles(outcome.changedFiles) &&
      outcome.verification.status !== 'passed'
    ) {
      target.required = true;
    }
    targets.set(key, target);
  }
  return [...targets.values()]
    .filter((target) => target.required)
    .map((target) => ({
      repoId: target.repoId,
      changedFiles: [...target.changedFiles].sort(),
      verificationDigest: target.verification.join('\n')
    }));
}

export async function executeConductorValidation(input: {
  target: ConductorValidationTarget;
  goal: string;
  runId: string;
  signal?: AbortSignal;
  workspaceRoot?: string;
  runSubagent: SubagentRunner;
}): Promise<ValidationExecutionCompletion> {
  try {
    const spawned = await input.runSubagent({
      prompt: renderPrompt('conductor.validation.user', {
        goal: input.goal,
        rootLabel: input.target.repoId ?? 'primary',
        changedFiles: input.target.changedFiles.join('\n') || '—',
        verificationDigest: input.target.verificationDigest || '—'
      }),
      title: `验证 ${input.target.repoId ?? 'primary'}`.slice(0, 48),
      mode: 'explore',
      role: 'validator',
      systemPrompt: renderPrompt('conductor.validation'),
      verificationChangedFiles: input.target.changedFiles,
      parentRunId: input.runId,
      parentDepth: 0,
      signal: input.signal,
      repoId: input.target.repoId,
      workspaceRoot: input.workspaceRoot,
      preferWorkerModel: true
    });
    return {
      outcome: {
        repoId: input.target.repoId,
        status: spawned.result.status,
        summary: spawned.result.summary,
        changedFiles: input.target.changedFiles,
        verification: spawned.result.verification,
        evidence: spawned.result.evidence,
        risks: spawned.result.risks
      }
    };
  } catch (error) {
    if (isOperationAborted(error, input.signal)) {
      return {
        outcome: failedValidationOutcome(input.target, 'Validation aborted'),
        abortError: error
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { outcome: failedValidationOutcome(input.target, message) };
  }
}

export function failedWorkerOutcome(
  task: ConductorTask,
  message: string
): ConductorTaskOutcome {
  return {
    taskId: task.id,
    title: task.title,
    repoId: task.repoId,
    status: 'failed',
    summary: message,
    changedFiles: [],
    evidence: [],
    risks: [message],
    needsReview: ['Worker execution failed before producing a usable result.'],
    verification: failedWorkerVerification(message),
    executionIncomplete: true,
    retrySafe: false
  };
}

function isRetryableWorkerOutcome(outcome: ConductorTaskOutcome): boolean {
  return (
    outcome.retrySafe === true &&
    outcome.changedFiles.length === 0 &&
    (outcome.status === 'failed' || outcome.status === 'needs-review')
  );
}

function failedValidationOutcome(
  target: ConductorValidationTarget,
  message: string
): ConductorValidationOutcome {
  return {
    repoId: target.repoId,
    status: 'failed',
    summary: message,
    changedFiles: target.changedFiles,
    verification: {
      status: 'failed',
      commands: [],
      evidence: [],
      reason: `Validation worker failed: ${message}`
    },
    evidence: [],
    risks: [message]
  };
}

function failedWorkerVerification(message: string): VerificationReport {
  return {
    status: 'not-run',
    commands: [],
    evidence: [],
    reason: `Worker failed before verification completed: ${message}`
  };
}
