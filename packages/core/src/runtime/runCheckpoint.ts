import { z } from 'zod';

import { agentModeSchema, pendingToolApprovalSchema } from '../domain';
import { RUN_PHASES, type RunPhase } from './runPhase';

const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown()
});

/**
 * Durable boundary for an unfinished main-agent run.
 *
 * Only `awaiting-approval` checkpoints are resumable after a process restart:
 * the pending call has not executed yet. Completed calls are evidence only and
 * are never replayed.
 */
export const runCheckpointSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1),
    mode: agentModeSchema,
    originalUserInput: z.string(),
    status: z.enum(['running', 'awaiting-approval']),
    phase: z.enum(RUN_PHASES),
    iteration: z.number().int().positive(),
    verificationFollowupCount: z.number().int().nonnegative(),
    verificationState: z
      .enum(['unknown', 'pending', 'in-progress'])
      .optional(),
    completedCallIds: z.array(z.string().min(1)).max(1000),
    pendingCall: toolCallSchema.optional(),
    remainingCalls: z.array(toolCallSchema).max(200),
    pendingApproval: pendingToolApprovalSchema.optional(),
    updatedAt: z.string().datetime()
  })
  .superRefine((value, context) => {
    if (value.status === 'awaiting-approval') {
      if (!value.pendingCall) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'pendingCall is required'
        });
      }
      if (!value.pendingApproval) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'pendingApproval is required'
        });
      }
    }
  });

export interface RunCheckpointV1 {
  version: 1;
  runId: string;
  mode: z.infer<typeof agentModeSchema>;
  originalUserInput: string;
  status: 'running' | 'awaiting-approval';
  phase: RunPhase;
  iteration: number;
  verificationFollowupCount: number;
  verificationState?: 'unknown' | 'pending' | 'in-progress';
  completedCallIds: string[];
  pendingCall?: DurableToolCall;
  remainingCalls: DurableToolCall[];
  pendingApproval?: z.infer<typeof pendingToolApprovalSchema>;
  updatedAt: string;
}

export interface DurableToolCall {
  id: string;
  name: string;
  input?: unknown;
}

export function cloneRunCheckpoint(
  checkpoint: RunCheckpointV1
): RunCheckpointV1 {
  return runCheckpointSchema.parse(JSON.parse(JSON.stringify(checkpoint)));
}
