import { z } from 'zod';

export const HEADLESS_SCHEMA_VERSION = 1 as const;

export const headlessExitCodes = {
  success: 0,
  usage: 2,
  configuration: 3,
  approvalRequired: 4,
  runtimeFailed: 5,
  verificationFailed: 6,
  interrupted: 130
} as const;

export type HeadlessExitCode =
  (typeof headlessExitCodes)[keyof typeof headlessExitCodes];

export const headlessModeSchema = z.enum(['auto', 'plan', 'conductor']);
export const headlessPermissionSchema = z.enum([
  'default',
  'classifier',
  'auto'
]);

export const headlessExecRequestSchema = z.object({
  schemaVersion: z.literal(HEADLESS_SCHEMA_VERSION),
  input: z.discriminatedUnion('source', [
    z.object({
      source: z.literal('argument'),
      task: z.string().min(1)
    }),
    z.object({
      source: z.literal('stdin')
    })
  ]),
  mode: headlessModeSchema,
  permission: headlessPermissionSchema,
  cwd: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  json: z.literal(true)
});

export type HeadlessExecRequest = z.infer<typeof headlessExecRequestSchema>;

const headlessEventBaseSchema = z.object({
  schemaVersion: z.literal(HEADLESS_SCHEMA_VERSION),
  timestamp: z.string().datetime(),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
  sequence: z.number().int().nonnegative()
});

export const headlessEventSchema = z.discriminatedUnion('type', [
  headlessEventBaseSchema.extend({
    type: z.literal('run.started'),
    data: z.object({
      mode: headlessModeSchema,
      permission: headlessPermissionSchema,
      cwd: z.string().min(1)
    })
  }),
  headlessEventBaseSchema.extend({
    type: z.literal('turn.started'),
    data: z.object({
      iteration: z.number().int().positive()
    })
  }),
  headlessEventBaseSchema.extend({
    type: z.literal('tools.started'),
    data: z.object({
      iteration: z.number().int().positive(),
      count: z.number().int().nonnegative()
    })
  }),
  headlessEventBaseSchema.extend({
    type: z.enum(['text.delta', 'thinking.delta']),
    data: z.object({
      text: z.string()
    })
  }),
  headlessEventBaseSchema.extend({
    type: z.literal('approval.required'),
    data: z.object({
      toolCallId: z.string().min(1),
      toolName: z.string().min(1),
      risk: z.string().min(1),
      reason: z.string().optional()
    })
  }),
  headlessEventBaseSchema.extend({
    type: z.literal('run.completed'),
    data: z.object({
      status: z.enum(['completed', 'failed', 'cancelled']),
      summary: z.string(),
      verificationStatus: z.enum([
        'passed',
        'failed',
        'not-run',
        'not-needed'
      ]),
      changedFiles: z.array(z.string()),
      risks: z.array(z.string())
    })
  }),
  headlessEventBaseSchema.extend({
    type: z.literal('error'),
    data: z.object({
      category: z.enum([
        'usage',
        'configuration',
        'approval-required',
        'runtime',
        'verification',
        'interrupted'
      ]),
      message: z.string().min(1),
      retryable: z.boolean()
    })
  })
]);

export type HeadlessEvent = z.infer<typeof headlessEventSchema>;

export function serializeHeadlessEvent(event: HeadlessEvent): string {
  return `${JSON.stringify(headlessEventSchema.parse(event))}\n`;
}
