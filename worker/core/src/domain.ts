import { z } from 'zod';

export const runStatusSchema = z.enum([
  'pending',
  'running',
  'approval-required',
  'completed',
  'failed',
  'cancelled'
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const traceEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  type: z.string().min(1),
  timestamp: z.string().datetime(),
  parentId: z.string().min(1).optional(),
  payload: z.record(z.unknown()).default({})
});
export type TraceEvent = z.infer<typeof traceEventSchema>;

export const agentReportSchema = z.object({
  artifacts: z.array(z.string()),
  evidence: z.array(z.string()),
  incompleteItems: z.array(z.string())
});
export type AgentReport = z.infer<typeof agentReportSchema>;

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
  status: z.enum(['completed', 'failed', 'incomplete']),
  summary: z.string(),
  artifacts: z.array(z.string()),
  toolsUsed: z.array(z.string()).default([]),
  evidence: z.array(z.string()),
  incompleteItems: z.array(z.string())
});
export type SubagentResult = z.infer<typeof subagentResultSchema>;
