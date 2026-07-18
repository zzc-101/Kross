/**
 * Conductor = 高级模型编排，不是多目录。
 * 多目录是 /add-dir 的会话能力，任意 mode 可用。
 */

import {
  conductorTaskSchema,
  conductorTaskPlanSchema,
  type ConductorTask,
  type ConductorTaskPlan
} from '../modes/conductorPlan';
import type { VerificationReport } from '../domain';
import { requiresVerificationForFiles } from '../verification';

export {
  conductorTaskSchema,
  conductorTaskPlanSchema,
  type ConductorTask,
  type ConductorTaskPlan
} from '../modes/conductorPlan';

export interface ConductorTaskOutcome {
  taskId: string;
  title: string;
  repoId?: string;
  status: string;
  summary: string;
  changedFiles: string[];
  evidence: string[];
  risks: string[];
  needsReview: string[];
  verification: VerificationReport;
  attempts?: number;
  recovery?: 'retry' | 'replan';
  executionIncomplete?: boolean;
  retrySafe?: boolean;
}

export interface ConductorValidationOutcome {
  repoId?: string;
  status: string;
  summary: string;
  changedFiles: string[];
  verification: VerificationReport;
  evidence: string[];
  risks: string[];
}

export function formatConductorTaskPlanSummary(plan: ConductorTaskPlan): string {
  const lines = [
    '【指挥家计划 · 等待确认】',
    '',
    `目标：${plan.goal}`,
    plan.notes ? `说明：${plan.notes}` : undefined,
    '',
    '任务拆分（将由经济/快速模型子代理执行，高级模型验收）：',
    ...plan.tasks.map(
      (task, i) =>
        `${i + 1}. [${task.id}] ${task.title}` +
        (task.repoId ? `  · root=${task.repoId}` : '') +
        ((task.dependsOn?.length ?? 0) > 0
          ? `  · depends=${(task.dependsOn ?? []).join(',')}`
          : '') +
        `\n   ${task.prompt.slice(0, 200)}${task.prompt.length > 200 ? '…' : ''}`
    ),
    '',
    '输入 /approve 派生子代理执行并由高级模型验收，或 /reject 取消。',
    '说明：多目录请用 /add-dir（任意 mode 可用），与指挥家模式无关。'
  ].filter((line): line is string => line !== undefined);
  return lines.join('\n');
}

export function formatConductorReviewSummary(input: {
  goal: string;
  taskOutcomes: ConductorTaskOutcome[];
  reviewText: string;
}): string {
  const lines = [
    '【指挥家执行完成 · 高级模型验收】',
    `目标：${input.goal}`,
    '',
    '### Worker 子代理结果',
    ...input.taskOutcomes.flatMap((o) => [
      `#### ${o.taskId} — ${o.title} → ${o.status}`,
      o.summary,
      o.changedFiles.length > 0
        ? `变更：${o.changedFiles.join(', ')}`
        : '变更：（无）',
      `验证：${o.verification.status}` +
        (o.verification.commands.length > 0
          ? ` · ${o.verification.commands.join(', ')}`
          : ''),
      o.attempts && o.attempts > 1
        ? `执行：${o.attempts} 次${o.recovery ? ` · ${o.recovery}` : ''}`
        : undefined,
      o.risks.length > 0 ? `风险：${o.risks.join('；')}` : undefined,
      ''
    ]),
    '### 验收结论',
    input.reviewText
  ].filter((line): line is string => line !== undefined);
  return lines.join('\n').trim();
}

export function aggregateConductorVerification(
  outcomes: ConductorTaskOutcome[],
  validations: ConductorValidationOutcome[] = []
): VerificationReport {
  const validationByRoot = new Map(
    validations.map((validation) => [validation.repoId ?? '__primary__', validation])
  );
  const relevant = outcomes.filter(
    (outcome) =>
      requiresVerificationForFiles(outcome.changedFiles) ||
      outcome.verification.status === 'passed' ||
      outcome.verification.status === 'failed' ||
      (outcome.changedFiles.length === 0 &&
        outcome.verification.status === 'not-run')
  );
  if (relevant.length === 0) {
    return {
      status: 'not-needed',
      commands: [],
      evidence: [],
      reason: 'No worker workspace changes or verification commands were observed.'
    };
  }

  const commands = [
    ...new Set([
      ...relevant.flatMap((outcome) => outcome.verification.commands),
      ...validations.flatMap((validation) => validation.verification.commands)
    ])
  ];
  const evidence = [
    ...relevant.flatMap((outcome) =>
      outcome.verification.evidence.map(
        (item) => `${outcome.taskId}: ${item}`
      )
    ),
    ...validations.flatMap((validation) =>
      validation.verification.evidence.map(
        (item) => `validation(${validation.repoId ?? 'primary'}): ${item}`
      )
    )
  ];
  const effectiveVerification = relevant.map((outcome) => {
    if (!requiresVerificationForFiles(outcome.changedFiles)) {
      return outcome.verification;
    }
    const validation = validationByRoot.get(outcome.repoId ?? '__primary__');
    return validation?.verification.status === 'passed'
      ? validation.verification
      : validation?.verification ?? outcome.verification;
  });
  const hasFailed = effectiveVerification.some(
    (verification) => verification.status === 'failed'
  );
  const hasUnverifiedMutation = relevant.some(
    (outcome, index) =>
      requiresVerificationForFiles(outcome.changedFiles) &&
      effectiveVerification[index]?.status !== 'passed'
  );
  const hasNotRun = effectiveVerification.some(
    (verification) => verification.status === 'not-run'
  );

  if (hasFailed) {
    return {
      status: 'failed',
      commands,
      evidence,
      reason: 'At least one worker reported failed verification.'
    };
  }
  if (hasUnverifiedMutation || hasNotRun) {
    return {
      status: 'not-run',
      commands,
      evidence,
      reason: 'At least one worker change lacks passing verification evidence.'
    };
  }
  return { status: 'passed', commands, evidence };
}

export function parseReplannedConductorTask(
  original: ConductorTask,
  text: string
): ConductorTask | undefined {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  try {
    const raw = JSON.parse((fenced?.[1] ?? trimmed).trim()) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const prompt = 'prompt' in raw ? (raw as { prompt?: unknown }).prompt : undefined;
    const title = 'title' in raw ? (raw as { title?: unknown }).title : undefined;
    if (typeof prompt !== 'string' || !prompt.trim()) return undefined;
    return conductorTaskSchema.parse({
      ...original,
      title:
        typeof title === 'string' && title.trim()
          ? title.trim().slice(0, 120)
          : original.title,
      prompt: prompt.trim()
    });
  } catch {
    return undefined;
  }
}

export function parseConductorReviewVerdict(
  text: string
): 'pass' | 'needs-work' | undefined {
  const matches = [
    ...text.matchAll(/\bVERDICT\s*:\s*(PASS|NEEDS_WORK)\b/gi)
  ];
  const verdict = matches.at(-1)?.[1]?.toUpperCase();
  if (verdict === 'PASS') return 'pass';
  if (verdict === 'NEEDS_WORK') return 'needs-work';
  return undefined;
}

/** Heuristic fallback when senior model cannot emit structured tasks. */
export function buildDefaultConductorTasks(goal: string): ConductorTask[] {
  return [
    {
      id: 'explore',
      title: '探索与定位',
      prompt: [
        '只读探索任务。',
        `总体目标：${goal}`,
        '找出相关文件、关键符号与现状；不要修改文件。',
        '返回：路径列表、发现摘要、建议修改点。'
      ].join('\n')
    },
    {
      id: 'implement',
      title: '实现改动',
      prompt: [
        '实现任务。',
        `总体目标：${goal}`,
        '在工作区内完成最小必要改动；完成后列出变更文件与风险。'
      ].join('\n'),
      dependsOn: ['explore']
    }
  ];
}

/**
 * Parse senior-model JSON task plan. Accepts fenced ```json blocks.
 */
export function parseConductorTaskPlanFromText(
  goal: string,
  text: string
): ConductorTaskPlan {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  try {
    const raw = JSON.parse(candidate) as unknown;
    const parsed = conductorTaskPlanSchema.safeParse({
      ...(typeof raw === 'object' && raw !== null ? raw : {}),
      goal:
        typeof raw === 'object' &&
        raw !== null &&
        'goal' in raw &&
        typeof (raw as { goal: unknown }).goal === 'string'
          ? (raw as { goal: string }).goal
          : goal
    });
    if (parsed.success && parsed.data.tasks.length > 0) {
      return parsed.data;
    }
  } catch {
    // fall through
  }
  return {
    goal,
    notes: '高级模型未返回合法 JSON 任务列表，已使用默认两阶段拆分。',
    tasks: buildDefaultConductorTasks(goal)
  };
}
