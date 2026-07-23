import { z } from 'zod';

/** auto=默认 agent；plan=先计划后开发；conductor=指挥家多目标编排 */
export const agentModeSchema = z.enum(['auto', 'plan', 'conductor']);
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
  testCommand: z.string().min(1).optional()
});
export type RepoConfig = z.infer<typeof repoConfigSchema>;

export const projectConfigSchema = z.object({
  repos: z.array(repoConfigSchema).min(1)
});
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

/** ~/.kross/projects.json — multi-repo project registry (no codegraph required). */
export const projectRegistrySchema = z.object({
  /** Optional default project when cwd does not match a repo path. */
  defaultProjectId: z.string().min(1).optional(),
  projects: z.record(projectConfigSchema)
});
export type ProjectRegistry = z.infer<typeof projectRegistrySchema>;

export const impactRepoSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  type: z.string().min(1).optional(),
  reasons: z.array(z.string()).default([]),
  focusPaths: z.array(z.string()).optional(),
  /** Per-repo subagent task prompts (execution phase). */
  tasks: z.array(z.string()).optional()
});
export type ImpactRepo = z.infer<typeof impactRepoSchema>;

export const impactMapSchema = z.object({
  strategy: z.enum(['registry+llm', 'registry-only', 'heuristic']),
  projectId: z.string().min(1),
  repos: z.array(impactRepoSchema)
});
export type ImpactMap = z.infer<typeof impactMapSchema>;

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
  risks: z.array(z.string()),
  verification: z
    .object({
      status: z.enum(['passed', 'failed', 'not-run', 'not-needed']),
      commands: z.array(z.string()),
      evidence: z.array(z.string()),
      reason: z.string().optional()
    })
    .default({
      status: 'not-run',
      commands: [],
      evidence: [],
      reason: 'Verification evidence was not collected for this result.'
    })
});
export type AgentReport = z.infer<typeof agentReportSchema>;
export type VerificationReport = AgentReport['verification'];
export type VerificationStatus = VerificationReport['status'];

export const pendingToolApprovalSchema = z.object({
  runId: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  risk: z.string().min(1),
  reason: z.string().optional(),
  command: z.string().optional(),
  workDir: z.string().optional(),
  inputPreview: z.string()
});
export type PendingToolApproval = z.infer<typeof pendingToolApprovalSchema>;

export const agentResultSchema = z.object({
  runId: z.string().min(1),
  mode: agentModeSchema,
  status: z.enum(['completed', 'failed', 'cancelled', 'approval-required']),
  cancellationReason: z
    .enum([
      'user-interrupt',
      'approval-gate',
      'pending-approval',
      'missing-workspace-root',
      'system'
    ])
    .optional(),
  summary: z.string(),
  /** 最终一轮模型思考过程（审批恢复等非流式路径用）；不并入 summary。 */
  thinking: z.string().optional(),
  report: agentReportSchema,
  pendingApproval: pendingToolApprovalSchema.optional()
});
export type AgentResult = z.infer<typeof agentResultSchema>;

export const subagentResultSchema = z.object({
  status: z.enum(['completed', 'failed', 'needs-review']),
  summary: z.string(),
  changedFiles: z.array(z.string()),
  diffSummary: z.array(z.string()),
  commandsRun: z.array(z.string()),
  toolsUsed: z.array(z.string()).default([]),
  verification: agentReportSchema.shape.verification,
  evidence: z.array(z.string()),
  risks: z.array(z.string()),
  needsReview: z.array(z.string())
});
export type SubagentResult = z.infer<typeof subagentResultSchema>;
