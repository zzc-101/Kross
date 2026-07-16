import { z } from 'zod';

/**
 * Conductor = 高级模型编排，不是多目录。
 * 多目录是 /add-dir 的会话能力，任意 mode 可用。
 */

export const conductorTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** 交给经济/快速 worker 子代理的完整指令 */
  prompt: z.string().min(1),
  /**
   * 可选：绑定会话 workspace root id（/add-dir 的 id）。
   * 不填则 worker 使用主工作区。
   */
  repoId: z.string().min(1).optional()
});
export type ConductorTask = z.infer<typeof conductorTaskSchema>;

export const conductorTaskPlanSchema = z.object({
  goal: z.string().min(1),
  tasks: z.array(conductorTaskSchema).min(1),
  /** 给人看的步骤摘要 */
  notes: z.string().optional()
});
export type ConductorTaskPlan = z.infer<typeof conductorTaskPlanSchema>;

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
  taskOutcomes: Array<{
    taskId: string;
    title: string;
    status: string;
    summary: string;
    changedFiles: string[];
    risks: string[];
  }>;
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
      o.risks.length > 0 ? `风险：${o.risks.join('；')}` : undefined,
      ''
    ]),
    '### 验收结论',
    input.reviewText
  ].filter((line): line is string => line !== undefined);
  return lines.join('\n').trim();
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
