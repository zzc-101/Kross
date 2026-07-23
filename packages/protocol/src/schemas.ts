import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

export const protocolVersionSchema = z.literal(PROTOCOL_VERSION);
export const identifierSchema = z.string().min(1).max(200);
export const agentModeSchema = z.enum(['auto', 'plan', 'conductor']);
export const thinkingEffortSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
]);
export const traceEventSchema = z.object({
  id: identifierSchema,
  runId: identifierSchema,
  type: identifierSchema,
  timestamp: z.string().datetime(),
  parentId: identifierSchema.optional(),
  payload: z.record(z.unknown()).default({})
});
export const pendingToolApprovalSchema = z.object({
  runId: identifierSchema,
  toolCallId: identifierSchema,
  toolName: identifierSchema,
  risk: identifierSchema,
  reason: z.string().optional(),
  command: z.string().optional(),
  workDir: z.string().optional(),
  inputPreview: z.string()
});
const verificationSchema = z.object({
  status: z.enum(['passed', 'failed', 'not-run', 'not-needed']),
  commands: z.array(z.string()),
  evidence: z.array(z.string()),
  reason: z.string().optional()
});
export const agentResultSchema = z.object({
  runId: identifierSchema,
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
  thinking: z.string().optional(),
  report: z.object({
    changedFiles: z.array(z.string()),
    evidence: z.array(z.string()),
    risks: z.array(z.string()),
    verification: verificationSchema
  }),
  pendingApproval: pendingToolApprovalSchema.optional()
});
const gitRefSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);

export const workspaceSchema = z.object({
  id: identifierSchema,
  name: z.string().min(1).max(120),
  gitUrl: z.string().min(1),
  defaultBranch: z.string().min(1).optional(),
  status: z.enum(['creating', 'ready', 'stopped', 'error']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastActiveAt: z.string().datetime().optional(),
  error: z.string().optional()
});

export const workspaceProvisionStageSchema = z.enum([
  'validating',
  'provisioning',
  'cloning',
  'starting',
  'ready',
  'failed'
]);

export const sessionSummarySchema = z.object({
  id: identifierSchema,
  title: z.string(),
  preview: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  messageCount: z.number().int().nonnegative()
});

const toolCallStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'denied',
  'cancelled',
  'awaiting'
]);
const toolCallItemSchema = z.object({
  callId: z.string().optional(),
  path: z.string().optional(),
  preview: z.string().optional(),
  status: toolCallStatusSchema,
  summary: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  linesAdded: z.number().int().nonnegative().optional(),
  linesRemoved: z.number().int().nonnegative().optional()
});
export const storedToolCallSchema = z.object({
  callId: z.string().optional(),
  name: z.string().min(1),
  risk: z.string().optional(),
  status: toolCallStatusSchema,
  summary: z.string().optional(),
  inputPreview: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  linesAdded: z.number().int().nonnegative().optional(),
  linesRemoved: z.number().int().nonnegative().optional(),
  detailLines: z.array(
    z.object({
      text: z.string(),
      op: z.enum(['add', 'del', 'meta', 'ctx']).optional(),
      lineNo: z.number().int().positive().optional()
    })
  ).optional(),
  detailTruncated: z.boolean().optional(),
  items: z.array(toolCallItemSchema).optional()
});

export const storedMessageSchema = z.object({
  id: z.number().int().nonnegative(),
  from: z.enum(['user', 'agent', 'system', 'tool', 'thinking']),
  text: z.string(),
  createdAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative().optional(),
  expanded: z.boolean().optional(),
  tool: storedToolCallSchema.optional(),
  verification: verificationSchema.optional()
});

export const streamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn-start'), iteration: z.number().int() }),
  z.object({
    type: z.literal('tools-start'),
    iteration: z.number().int(),
    count: z.number().int().nonnegative()
  }),
  z.object({ type: z.literal('text-delta'), text: z.string() }),
  z.object({ type: z.literal('thinking-delta'), text: z.string() }),
  z.object({ type: z.literal('result'), result: agentResultSchema })
]);

export const sessionSnapshotSchema = z.object({
  summary: sessionSummarySchema,
  messages: z.array(storedMessageSchema),
  pendingApproval: pendingToolApprovalSchema.optional(),
  pendingPlan: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('plan'),
        goal: z.string(),
        mode: z.literal('plan'),
        planText: z.string()
      }),
      z.object({
        kind: z.literal('conductor'),
        goal: z.string(),
        mode: z.literal('conductor'),
        plan: z.unknown()
      })
    ])
    .optional(),
  todos: z.array(
    z.object({
      id: identifierSchema,
      content: z.string(),
      status: z.enum(['pending', 'in_progress', 'completed', 'cancelled'])
    })
  ),
  traces: z.array(traceEventSchema).default([]),
  mode: agentModeSchema,
  model: z.string().optional(),
  thinkingEffort: thinkingEffortSchema.optional()
});

const commandBase = {
  protocolVersion: protocolVersionSchema,
  requestId: identifierSchema
};

export const clientCommandSchema = z.discriminatedUnion('type', [
  z.object({
    ...commandBase,
    type: z.literal('session.create'),
    workspaceId: identifierSchema
  }),
  z.object({
    ...commandBase,
    type: z.literal('session.list'),
    workspaceId: identifierSchema,
    limit: z.number().int().positive().max(100).optional()
  }),
  z.object({
    ...commandBase,
    type: z.literal('session.resume'),
    workspaceId: identifierSchema,
    sessionId: identifierSchema,
    lastSeq: z.number().int().nonnegative().optional()
  }),
  z.object({
    ...commandBase,
    type: z.literal('session.rename'),
    workspaceId: identifierSchema,
    sessionId: identifierSchema,
    title: z.string().trim().min(1).max(200)
  }),
  z.object({
    ...commandBase,
    type: z.literal('session.delete'),
    workspaceId: identifierSchema,
    sessionId: identifierSchema
  }),
  z.object({
    ...commandBase,
    type: z.literal('session.input'),
    workspaceId: identifierSchema,
    sessionId: identifierSchema,
    input: z.string().min(1),
    mode: agentModeSchema.default('auto'),
    planApproved: z.boolean().optional()
  }),
  z.object({
    ...commandBase,
    type: z.literal('session.approval'),
    workspaceId: identifierSchema,
    sessionId: identifierSchema,
    runId: identifierSchema,
    approved: z.boolean(),
    reason: z.string().trim().max(2000).optional()
  }),
  z.object({
    ...commandBase,
    type: z.literal('session.plan-approval'),
    workspaceId: identifierSchema,
    sessionId: identifierSchema,
    approved: z.boolean(),
    input: z.string().min(1).optional()
  }),
  z.object({
    ...commandBase,
    type: z.literal('session.abort'),
    workspaceId: identifierSchema,
    sessionId: identifierSchema
  }),
  z.object({
    ...commandBase,
    type: z.literal('session.settings'),
    workspaceId: identifierSchema,
    sessionId: identifierSchema,
    model: z.string().min(1).optional(),
    thinkingEffort: thinkingEffortSchema.optional(),
    mode: agentModeSchema.optional()
  }),
  z.object({
    ...commandBase,
    type: z.literal('session.inspect'),
    workspaceId: identifierSchema,
    sessionId: identifierSchema,
    kind: z.enum(['trace', 'diff']),
    argument: z.string().optional()
  }),
  z.object({
    ...commandBase,
    type: z.literal('workspace.list')
  }),
  z.object({
    ...commandBase,
    type: z.literal('workspace.create'),
    name: z.string().min(1).max(120),
    gitUrl: z.string().min(1),
    defaultBranch: gitRefSchema.optional(),
    credential: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('https-token'), token: z.string().min(1) }),
        z.object({ type: z.literal('ssh-key'), privateKey: z.string().min(1) })
      ])
      .optional()
  }),
  z.object({
    ...commandBase,
    type: z.literal('workspace.start'),
    workspaceId: identifierSchema
  }),
  z.object({
    ...commandBase,
    type: z.literal('workspace.stop'),
    workspaceId: identifierSchema
  }),
  z.object({
    ...commandBase,
    type: z.literal('workspace.status'),
    workspaceId: identifierSchema
  }),
  z.object({
    ...commandBase,
    type: z.literal('models.list'),
    workspaceId: identifierSchema
  }),
  z.object({
    ...commandBase,
    type: z.literal('workspace.delete'),
    workspaceId: identifierSchema,
    removeVolume: z.boolean().default(false)
  }),
  z.object({
    ...commandBase,
    type: z.literal('git.push'),
    workspaceId: identifierSchema,
    sessionId: identifierSchema,
    remote: gitRefSchema.default('origin'),
    branch: gitRefSchema,
    setUpstream: z.boolean().default(true)
  }),
  z.object({
    ...commandBase,
    type: z.literal('git.pull-request'),
    workspaceId: identifierSchema,
    sessionId: identifierSchema,
    title: z.string().min(1),
    body: z.string().default(''),
    base: gitRefSchema,
    head: gitRefSchema
  }),
  z.object({
    ...commandBase,
    type: z.literal('push.subscribe'),
    subscription: z.object({
      endpoint: z
        .string()
        .url()
        .refine((value) => value.startsWith('https://'), {
          message: 'Push endpoint 必须使用 HTTPS'
        }),
      expirationTime: z.number().nullable().optional(),
      keys: z.object({ p256dh: z.string(), auth: z.string() })
    })
  })
]);

export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('request.accepted'),
    requestId: identifierSchema
  }),
  z.object({
    type: z.literal('request.error'),
    requestId: identifierSchema.optional(),
    code: z.string().min(1),
    message: z.string()
  }),
  z.object({ type: z.literal('stream'), data: streamEventSchema }),
  z.object({ type: z.literal('trace'), data: traceEventSchema }),
  z.object({ type: z.literal('approval.pending'), data: pendingToolApprovalSchema }),
  z.object({ type: z.literal('session.snapshot'), data: sessionSnapshotSchema }),
  z.object({
    type: z.literal('session.list'),
    data: z.array(sessionSummarySchema)
  }),
  z.object({
    type: z.literal('session.updated'),
    data: sessionSummarySchema
  }),
  z.object({
    type: z.literal('session.deleted'),
    data: z.object({ sessionId: identifierSchema })
  }),
  z.object({ type: z.literal('workspace.list'), data: z.array(workspaceSchema) }),
  z.object({ type: z.literal('workspace.updated'), data: workspaceSchema }),
  z.object({
    type: z.literal('workspace.runtime-status'),
    data: z.object({
      activeRuns: z.number().int().nonnegative(),
      loadedSessions: z.number().int().nonnegative()
    })
  }),
  z.object({
    type: z.literal('models.list'),
    data: z.array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        provider: z.string().min(1)
      })
    )
  }),
  z.object({
    type: z.literal('workspace.progress'),
    data: z.object({
      requestId: identifierSchema,
      workspaceId: identifierSchema,
      name: z.string().min(1).max(120),
      stage: workspaceProvisionStageSchema,
      message: z.string().min(1)
    })
  }),
  z.object({
    type: z.literal('todo.snapshot'),
    data: sessionSnapshotSchema.shape.todos
  }),
  z.object({
    type: z.literal('git.result'),
    data: z.object({
      operation: z.enum(['push', 'pull-request']),
      ok: z.boolean(),
      output: z.string(),
      url: z.string().url().optional()
    })
  }),
  z.object({
    type: z.literal('inspection.result'),
    data: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('trace'), content: z.string() }),
      z.object({
        kind: z.literal('diff'),
        summary: z.string(),
        patches: z.array(
          z.object({
            staged: z.boolean(),
            patch: z.string()
          })
        )
      })
    ])
  }),
  z.object({
    type: z.literal('replay.complete'),
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative()
  })
]);

export const eventEnvelopeSchema = z.object({
  protocolVersion: protocolVersionSchema,
  source: z.enum(['gateway', 'worker']).optional(),
  workspaceId: identifierSchema,
  sessionId: identifierSchema.optional(),
  correlationId: identifierSchema.optional(),
  seq: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  event: serverEventSchema
});
