import { z } from 'zod';

import { agentModeSchema, type AgentMode } from '../domain';
import { conductorTaskPlanSchema } from '../modes/conductorPlan';
import type { PendingModeExecution } from '../modes/pendingExecution';
import { TODO_STATUSES, type TodoItem } from '../todo/todoStore';
import {
  runCheckpointSchema,
  type RunCheckpointV1
} from '../runtime/runCheckpoint';

const todoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(TODO_STATUSES)
});

export const pendingModeExecutionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('plan'),
    goal: z.string().min(1),
    mode: z.literal('plan'),
    planText: z.string().min(1)
  }),
  z.object({
    kind: z.literal('conductor'),
    goal: z.string().min(1),
    mode: z.literal('conductor'),
    plan: conductorTaskPlanSchema
  })
]);

export const sessionWorkStateSchema = z.object({
  version: z.literal(1),
  todos: z.array(todoItemSchema).max(500),
  pendingModeExecution: pendingModeExecutionSchema.optional(),
  sessionMode: agentModeSchema,
  runCheckpoint: runCheckpointSchema.optional()
});

export interface SessionWorkStateV1 {
  version: 1;
  todos: TodoItem[];
  pendingModeExecution?: PendingModeExecution;
  sessionMode: AgentMode;
  runCheckpoint?: RunCheckpointV1;
}

export function isSessionWorkState(value: unknown): value is SessionWorkStateV1 {
  return sessionWorkStateSchema.safeParse(value).success;
}

export function cloneSessionWorkState(state: SessionWorkStateV1): SessionWorkStateV1 {
  return sessionWorkStateSchema.parse(JSON.parse(JSON.stringify(state)));
}
