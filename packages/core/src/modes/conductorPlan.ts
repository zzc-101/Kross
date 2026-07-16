import { z } from 'zod';

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
