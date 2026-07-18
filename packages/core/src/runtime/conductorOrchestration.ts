/**
 * Conductor = 高级模型编排，不是多目录。
 * 多目录是 /add-dir 的会话能力，任意 mode 可用。
 */

import {
  conductorTaskPlanSchema,
  type ConductorTask,
  type ConductorTaskPlan
} from '../modes/conductorPlan';
import type { VerificationReport } from '../domain';

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
      o.risks.length > 0 ? `风险：${o.risks.join('；')}` : undefined,
      ''
    ]),
    '### 验收结论',
    input.reviewText
  ].filter((line): line is string => line !== undefined);
  return lines.join('\n').trim();
}

export function aggregateConductorVerification(
  outcomes: ConductorTaskOutcome[]
): VerificationReport {
  const relevant = outcomes.filter(
    (outcome) =>
      outcome.changedFiles.length > 0 ||
      outcome.verification.status !== 'not-needed'
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
    ...new Set(relevant.flatMap((outcome) => outcome.verification.commands))
  ];
  const evidence = relevant.flatMap((outcome) =>
    outcome.verification.evidence.map(
      (item) => `${outcome.taskId}: ${item}`
    )
  );
  const hasFailed = relevant.some(
    (outcome) => outcome.verification.status === 'failed'
  );
  const hasUnverifiedMutation = relevant.some(
    (outcome) =>
      outcome.changedFiles.length > 0 &&
      outcome.verification.status !== 'passed'
  );
  const hasNotRun = relevant.some(
    (outcome) => outcome.verification.status === 'not-run'
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
      ].join('\n')
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
