import { z } from 'zod';

export const agentModeSchema = z.enum(['auto', 'normal', 'cross-repo']);
export type AgentMode = z.infer<typeof agentModeSchema>;

export const runStatusSchema = z.enum([
  'pending',
  'running',
  'approval-required',
  'completed',
  'failed',
  'cancelled'
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const repoConfigSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  type: z.string().min(1),
  testCommand: z.string().min(1).optional(),
  codegraphIndex: z.string().min(1).optional()
});
export type RepoConfig = z.infer<typeof repoConfigSchema>;

export const projectConfigSchema = z.object({
  repos: z.array(repoConfigSchema).min(1)
});
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export const projectRegistrySchema = z.object({
  projects: z.record(projectConfigSchema)
});
export type ProjectRegistry = z.infer<typeof projectRegistrySchema>;

export const traceEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  type: z.string().min(1),
  timestamp: z.string().datetime(),
  parentId: z.string().min(1).optional(),
  payload: z.record(z.unknown()).default({})
});
export type TraceEvent = z.infer<typeof traceEventSchema>;

export interface TaskNode {
  id: string;
  title: string;
  status: RunStatus;
  repoId?: string;
  children: TaskNode[];
}

interface TaskNodeInput {
  id: string;
  title: string;
  status: RunStatus;
  repoId?: string;
  children?: TaskNodeInput[];
}

export const taskNodeSchema: z.ZodType<TaskNode, z.ZodTypeDef, TaskNodeInput> = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: runStatusSchema,
  repoId: z.string().min(1).optional(),
  children: z.lazy(() => z.array(taskNodeSchema)).default([])
});

export const agentReportSchema = z.object({
  changedFiles: z.array(z.string()),
  evidence: z.array(z.string()),
  risks: z.array(z.string())
});
export type AgentReport = z.infer<typeof agentReportSchema>;

export const agentResultSchema = z.object({
  runId: z.string().min(1),
  mode: agentModeSchema.exclude(['auto']),
  status: z.enum(['completed', 'failed', 'cancelled']),
  summary: z.string(),
  report: agentReportSchema
});
export type AgentResult = z.infer<typeof agentResultSchema>;

export const subagentResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'needs-review']),
  summary: z.string(),
  changedFiles: z.array(z.string()),
  diffSummary: z.array(z.string()),
  commandsRun: z.array(z.string()),
  evidence: z.array(z.string()),
  risks: z.array(z.string()),
  needsReview: z.array(z.string())
});
export type SubagentResult = z.infer<typeof subagentResultSchema>;
