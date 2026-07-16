import type {
  CrossRepoPlan,
  ImpactMap,
  ImpactRepo,
  ProjectConfig,
  RepoConfig
} from '../domain';
import { impactMapSchema } from '../domain';

/**
 * Build impact map without codegraph: keyword match on repo id/type,
 * or include all repos when the goal looks cross-cutting.
 */
export function buildImpactMapFromRegistry(input: {
  projectId: string;
  project: ProjectConfig;
  goal: string;
}): ImpactMap {
  const goal = input.goal.trim();
  const lower = goal.toLowerCase();
  const matched: ImpactRepo[] = [];

  for (const repo of input.project.repos) {
    const reasons = matchRepoReasons(repo, lower, goal);
    if (reasons.length > 0) {
      matched.push({
        id: repo.id,
        path: repo.path,
        type: repo.type,
        reasons,
        tasks: [
          buildDefaultRepoTask({
            goal,
            repo,
            reasons
          })
        ]
      });
    }
  }

  const repos =
    matched.length > 0
      ? matched
      : input.project.repos.map((repo) => ({
          id: repo.id,
          path: repo.path,
          type: repo.type,
          reasons: [
            '未命中具体仓库关键词，默认纳入全部仓库；确认后将在各仓派生子代理'
          ],
          tasks: [
            buildDefaultRepoTask({
              goal,
              repo,
              reasons: ['full-project scope']
            })
          ]
        }));

  return impactMapSchema.parse({
    strategy: matched.length > 0 ? 'heuristic' : 'registry-only',
    projectId: input.projectId,
    repos
  });
}

function matchRepoReasons(
  repo: RepoConfig,
  lowerGoal: string,
  goal: string
): string[] {
  const reasons: string[] = [];
  const id = repo.id.toLowerCase();
  const type = repo.type.toLowerCase();

  if (lowerGoal.includes(id)) {
    reasons.push(`目标文本命中 repo id「${repo.id}」`);
  }
  if (lowerGoal.includes(type)) {
    reasons.push(`目标文本命中 type「${repo.type}」`);
  }

  const backendish =
    /backend|后端|api|server|java|spring|服务端/.test(type) ||
    /backend|后端|api|server/.test(id);
  const frontendish =
    /frontend|前端|web|vue|react|ui|管理端|admin/.test(type) ||
    /frontend|前端|web|ui|admin/.test(id);

  if (backendish && /后端|前后端|接口|api|openapi|字段|服务端/.test(goal)) {
    reasons.push('目标涉及后端/接口/字段，匹配 backend 类仓库');
  }
  if (
    frontendish &&
    /前端|前后端|管理端|页面|ui|client|openapi/.test(goal)
  ) {
    reasons.push('目标涉及前端/页面/客户端，匹配 frontend 类仓库');
  }
  if (/跨仓库|跨系统|联动|贯通/.test(goal)) {
    reasons.push('目标含跨仓/联动信号');
  }

  return dedupe(reasons);
}

function buildDefaultRepoTask(input: {
  goal: string;
  repo: RepoConfig;
  reasons: string[];
}): string {
  return [
    `在仓库 ${input.repo.id}（${input.repo.type}，路径 ${input.repo.path}）中推进跨仓任务。`,
    `总体目标：${input.goal}`,
    `纳入原因：${input.reasons.join('；')}`,
    '约束：只修改本仓库内文件；完成后给出变更摘要、关键路径与风险。'
  ].join('\n');
}

export function buildCrossRepoPlan(input: {
  goal: string;
  projectId: string;
  impact: ImpactMap;
  llmSuggestion?: string;
}): CrossRepoPlan {
  const repoSteps = input.impact.repos.map(
    (repo) =>
      `在 ${repo.id}（${repo.type ?? 'repo'}）执行：${(repo.tasks?.[0] ?? repo.reasons[0] ?? '按目标修改').slice(0, 120)}`
  );
  return {
    goal: input.goal,
    projectId: input.projectId,
    llmSuggestion: input.llmSuggestion,
    steps: [
      `使用 project registry 中的项目 ${input.projectId}`,
      `生成影响面（strategy=${input.impact.strategy}，repos=${input.impact.repos.map((r) => r.id).join(', ')}）`,
      ...repoSteps,
      '用户确认后按仓库顺序派生子代理执行并汇总'
    ]
  };
}

export function formatCrossRepoPlanSummary(input: {
  plan: CrossRepoPlan;
  impact: ImpactMap;
  registrySource?: string;
}): string {
  const lines = [
    '【跨仓库计划 · 等待确认】',
    `项目：${input.plan.projectId}`,
    input.registrySource ? `Registry：${input.registrySource}` : undefined,
    `影响面（${input.impact.strategy}）：`,
    ...input.impact.repos.map(
      (repo) =>
        `- ${repo.id} [${repo.type ?? '?'}] ${repo.path}\n  原因：${repo.reasons.join('；') || '—'}`
    ),
    '步骤：',
    ...input.plan.steps.map((step, i) => `${i + 1}. ${step}`),
    '',
    '输入 /approve 开始按仓库派生子代理执行，或 /reject 取消。',
    '不依赖 codegraph；影响面来自 registry + 目标关键词启发式。'
  ].filter((line): line is string => line !== undefined);
  return lines.join('\n');
}

export function formatCrossRepoExecutionSummary(input: {
  projectId: string;
  goal: string;
  outcomes: Array<{
    repoId: string;
    status: string;
    summary: string;
    changedFiles: string[];
    risks: string[];
  }>;
}): string {
  const lines = [
    `【跨仓库执行完成】项目 ${input.projectId}`,
    `目标：${input.goal}`,
    '',
    ...input.outcomes.flatMap((o) => [
      `### ${o.repoId} → ${o.status}`,
      o.summary,
      o.changedFiles.length > 0
        ? `变更：${o.changedFiles.join(', ')}`
        : '变更：（无）',
      o.risks.length > 0 ? `风险：${o.risks.join('；')}` : undefined,
      ''
    ])
  ].filter((line): line is string => line !== undefined);
  return lines.join('\n').trim();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
