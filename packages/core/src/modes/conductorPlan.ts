import { z } from 'zod';

export const conductorTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** 交给经济/快速 worker 子代理的完整指令 */
  prompt: z.string().min(1),
  /** 必须先成功完成的任务 id；省略表示没有依赖。 */
  dependsOn: z.array(z.string().min(1)).optional(),
  /**
   * 可选：绑定会话 workspace root id（/add-dir 的 id）。
   * 不填则 worker 使用主工作区。
   */
  repoId: z.string().min(1).optional()
});
export type ConductorTask = z.infer<typeof conductorTaskSchema>;

export const conductorTaskPlanSchema = z
  .object({
    goal: z.string().min(1),
    tasks: z.array(conductorTaskSchema).min(1),
    /** 给人看的步骤摘要 */
    notes: z.string().optional()
  })
  .superRefine((plan, context) => {
    const ids = new Set<string>();
    for (const [index, task] of plan.tasks.entries()) {
      if (ids.has(task.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', index, 'id'],
          message: `Duplicate conductor task id: ${task.id}`
        });
      }
      ids.add(task.id);
    }
    for (const [index, task] of plan.tasks.entries()) {
      for (const dependency of task.dependsOn ?? []) {
        if (dependency === task.id || !ids.has(dependency)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tasks', index, 'dependsOn'],
            message:
              dependency === task.id
                ? `Task ${task.id} cannot depend on itself`
                : `Unknown conductor task dependency: ${dependency}`
          });
        }
      }
    }
    if (hasDependencyCycle(plan.tasks)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tasks'],
        message: 'Conductor task dependencies must be acyclic'
      });
    }
  });
export type ConductorTaskPlan = z.infer<typeof conductorTaskPlanSchema>;

function hasDependencyCycle(tasks: ConductorTask[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return tasks.some((task) => visit(task.id));
}
