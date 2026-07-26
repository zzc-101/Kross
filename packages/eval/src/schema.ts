import { z } from 'zod';

const fixtureResponseSchema = z.object({
  text: z.string().default(''),
  thinking: z.string().optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        input: z.record(z.unknown())
      })
    )
    .optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().default(0),
      outputTokens: z.number().int().nonnegative().default(0)
    })
    .default({ inputTokens: 0, outputTokens: 0 })
});

const verificationCommandSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  expectedExitCode: z.number().int().min(0).max(255).default(0),
  timeoutMs: z.number().int().positive().max(120_000).default(10_000)
});

const workflowSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('run')
  }),
  z.object({
    kind: z.literal('checkpoint-resume'),
    approvalTool: z.string().min(1)
  }),
  z.object({
    kind: z.literal('conductor'),
    workerChanges: z.array(
      z.object({
        path: z.string().min(1),
        content: z.string()
      })
    ).min(1),
    workerVerification: z.enum(['passed', 'failed', 'not-run']),
    reviewerVerdict: z.enum(['PASS', 'NEEDS_WORK']),
    reviewerInspectsDiff: z.boolean()
  })
]);

export const evalCaseSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  description: z.string().min(1),
  fixture: z.string().min(1),
  prompt: z.string().min(1),
  mode: z.enum(['auto', 'plan', 'conductor']).default('auto'),
  allowedTools: z.array(z.string().min(1)),
  limits: z.object({
    maxIterations: z.number().int().positive().max(200),
    timeoutMs: z.number().int().positive().max(300_000)
  }),
  workflow: workflowSchema.default({ kind: 'run' }),
  mustChange: z.array(z.string()).default([]),
  mustNotChange: z.array(z.string()).default([]),
  verification: z.array(verificationCommandSchema).default([]),
  assertions: z.object({
    resultStatus: z.enum([
      'completed',
      'failed',
      'cancelled',
      'approval-required'
    ]),
    verificationStatus: z
      .enum(['passed', 'failed', 'not-run', 'not-needed'])
      .optional(),
    requiredToolCalls: z.array(z.string()).default([]),
    forbiddenToolCalls: z.array(z.string()).default([]),
    toolCallCounts: z.record(z.number().int().nonnegative()).default({}),
    requiredTraceEvents: z.array(z.string().min(1)).default([]),
    forbiddenTraceEvents: z.array(z.string().min(1)).default([])
  }),
  tags: z.array(z.string()).default([]),
  capabilities: z.array(z.string()).default([]),
  fixtureResponses: z.array(fixtureResponseSchema).min(1)
});

const changedFileSchema = z.object({
  path: z.string(),
  kind: z.enum(['added', 'modified', 'deleted'])
});

const verificationResultSchema = z.object({
  name: z.string(),
  command: z.string(),
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string()
});

export const evalReportSchema = z.object({
  schemaVersion: z.literal(1),
  caseId: z.string(),
  description: z.string(),
  deterministic: z.boolean(),
  workflow: z.enum(['run', 'checkpoint-resume', 'conductor']),
  runtime: z.object({
    applicationVersion: z.string(),
    promptVersion: z.number().int().positive(),
    provider: z.string().min(1),
    model: z.string()
  }),
  status: z.enum(['passed', 'failed', 'error', 'timeout']),
  score: z.object({
    earned: z.number().int().nonnegative(),
    possible: z.number().int().nonnegative()
  }),
  changedFiles: z.array(changedFileSchema),
  verification: z.array(verificationResultSchema),
  toolCalls: z.array(z.object({
    name: z.string(),
    status: z.enum(['completed', 'failed'])
  })),
  traceEvents: z.array(z.string()),
  toolIterations: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative().optional()
  }),
  result: z
    .object({
      status: z.enum([
        'completed',
        'failed',
        'cancelled',
        'approval-required'
      ]),
      verificationStatus: z.enum([
        'passed',
        'failed',
        'not-run',
        'not-needed'
      ])
    })
    .optional(),
  assertions: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    details: z.string()
  })),
  failureCategory: z
    .enum([
      'assertion',
      'configuration',
      'runtime',
      'timeout',
      'verification'
    ])
    .optional(),
  providerErrorCategory: z
    .enum([
      'authentication',
      'permission',
      'rate-limit',
      'invalid-request',
      'server',
      'network',
      'timeout',
      'aborted',
      'unknown'
    ])
    .optional(),
  error: z.string().optional(),
  tags: z.array(z.string()),
  capabilities: z.array(z.string())
});

export type EvalCase = z.infer<typeof evalCaseSchema>;
export type EvalReport = z.infer<typeof evalReportSchema>;
export type FixtureResponse = z.infer<typeof fixtureResponseSchema>;
