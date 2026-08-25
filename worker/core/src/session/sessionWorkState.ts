import { z } from 'zod';

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

export const sessionWorkStateSchema = z.object({
  version: z.literal(1),
  todos: z.array(todoItemSchema).max(500),
  runCheckpoint: runCheckpointSchema.optional()
});

export interface SessionWorkStateV1 {
  version: 1;
  todos: TodoItem[];
  runCheckpoint?: RunCheckpointV1;
}

export function isSessionWorkState(value: unknown): value is SessionWorkStateV1 {
  return sessionWorkStateSchema.safeParse(value).success;
}

export function cloneSessionWorkState(state: SessionWorkStateV1): SessionWorkStateV1 {
  return sessionWorkStateSchema.parse(JSON.parse(JSON.stringify(state)));
}
