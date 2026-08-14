import { z } from 'zod';

import {
  approvalIdSchema,
  artifactIdSchema,
  byteCountSchema,
  failureSchema,
  httpUrlSchema,
  idempotencyKeySchema,
  inlineTextSchema,
  isoDateTimeSchema,
  mimeTypeSchema,
  nonEmptyInlineTextSchema,
  notificationIdSchema,
  optionalSummarySchema,
  organizationIdSchema,
  paginatedSchema,
  projectIdSchema,
  riskLevelSchema,
  runIdSchema,
  sha256Schema,
  shortLabelSchema,
  sourceIdSchema,
  summarySchema,
  taskIdSchema,
  taskMessageIdSchema,
  userIdSchema,
  workAgentModeSchema
} from './commonSchemas';
import { PROTOCOL_LIMITS } from './limits';

export const sourceKinds = [
  'upload',
  'url',
  'repository',
  'connector',
  'generated'
] as const;
export const sourceStatuses = [
  'uploading',
  'processing',
  'ready',
  'failed',
  'deleted'
] as const;
export const taskTypes = [
  'general',
  'research',
  'document',
  'data',
  'coding',
  'automation'
] as const;
export const taskStatuses = ['open', 'completed', 'cancelled', 'archived'] as const;
export const runStatuses = [
  'queued',
  'provisioning',
  'running',
  'waiting_for_approval',
  'cancelling',
  'completed',
  'failed',
  'cancelled'
] as const;
export const approvalKinds = ['plan', 'tool', 'external_action', 'elevated_access'] as const;
export const approvalStatuses = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled'
] as const;
export const artifactKinds = [
  'document',
  'spreadsheet',
  'presentation',
  'image',
  'data',
  'code',
  'archive',
  'other'
] as const;
export const artifactStatuses = ['pending', 'ready', 'failed', 'deleted'] as const;

export const taskTypeSchema = z.enum(taskTypes);
export const taskStatusSchema = z.enum(taskStatuses);
export const runStatusSchema = z.enum(runStatuses);
export const sourceKindSchema = z.enum(sourceKinds);
export const sourceStatusSchema = z.enum(sourceStatuses);
export const artifactKindSchema = z.enum(artifactKinds);
export const artifactStatusSchema = z.enum(artifactStatuses);
export const approvalKindSchema = z.enum(approvalKinds);
export const approvalStatusSchema = z.enum(approvalStatuses);
export const approvalDecisionSchema = z.enum(['approved', 'rejected']);

const constraintsSchema = z.array(nonEmptyInlineTextSchema).max(50);
const acceptanceCriteriaSchema = z.array(nonEmptyInlineTextSchema).max(50);

export const taskSummarySchema = z
  .object({
    id: taskIdSchema,
    organizationId: organizationIdSchema,
    projectId: projectIdSchema,
    type: taskTypeSchema,
    status: taskStatusSchema,
    title: shortLabelSchema,
    objectivePreview: optionalSummarySchema,
    latestRunId: runIdSchema.optional(),
    messageCount: z.number().int().nonnegative(),
    createdBy: userIdSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict();

export const taskSnapshotSchema = z
  .object({
    id: taskIdSchema,
    organizationId: organizationIdSchema,
    projectId: projectIdSchema,
    type: taskTypeSchema,
    status: taskStatusSchema,
    title: shortLabelSchema,
    objective: nonEmptyInlineTextSchema,
    constraints: constraintsSchema,
    acceptanceCriteria: acceptanceCriteriaSchema,
    latestRunId: runIdSchema.optional(),
    messageCount: z.number().int().nonnegative(),
    runCount: z.number().int().nonnegative(),
    sourceCount: z.number().int().nonnegative(),
    artifactCount: z.number().int().nonnegative(),
    createdBy: userIdSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.optional(),
    cancelledAt: isoDateTimeSchema.optional(),
    archivedAt: isoDateTimeSchema.optional()
  })
  .strict();

export const taskMessageContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: nonEmptyInlineTextSchema }).strict(),
  z
    .object({
      type: z.literal('source_reference'),
      sourceId: sourceIdSchema,
      label: shortLabelSchema.optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('artifact_reference'),
      artifactId: artifactIdSchema,
      label: shortLabelSchema.optional()
    })
    .strict()
]);

export const taskMessageSchema = z
  .object({
    id: taskMessageIdSchema,
    organizationId: organizationIdSchema,
    projectId: projectIdSchema,
    taskId: taskIdSchema,
    runId: runIdSchema.optional(),
    role: z.enum(['user', 'agent', 'system']),
    content: z.array(taskMessageContentBlockSchema).min(1).max(20),
    createdBy: userIdSchema.optional(),
    createdAt: isoDateTimeSchema
  })
  .strict();

export const taskPageSchema = paginatedSchema(taskSummarySchema);
export const taskMessagePageSchema = paginatedSchema(taskMessageSchema);

export const runUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative()
  })
  .strict();

export const runResourceLimitsSchema = z
  .object({
    cpuMillis: z.number().int().positive().max(64_000),
    memoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxPids: z.number().int().positive().max(1_000_000),
    diskBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxDurationMs: z.number().int().positive().max(86_400_000),
    maxSourceBytes: byteCountSchema,
    maxArtifactBytes: byteCountSchema,
    maxEventPayloadBytes: z.number().int().positive().max(1_048_576),
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().nonnegative().optional()
  })
  .strict();

export const approvalPolicySnapshotSchema = z
  .object({
    requirePlanApproval: z.boolean(),
    requireExternalActionApproval: z.boolean(),
    minimumToolRiskRequiringApproval: riskLevelSchema.nullable(),
    allowAdminOrganizationHighRiskApproval: z.boolean(),
    allowMemberHighRiskApproval: z.boolean()
  })
  .strict();

export const permissionPolicySnapshotSchema = z
  .object({
    version: z.number().int().positive(),
    allowNetworkAccess: z.boolean(),
    allowRepositoryWrite: z.boolean(),
    allowedConnectorScopes: z
      .array(z.string().min(1).max(240).regex(/\S/))
      .max(PROTOCOL_LIMITS.listItems),
    approvalPolicy: approvalPolicySnapshotSchema
  })
  .strict();

export const modelSnapshotSchema = z
  .object({
    requestedModelProfileId: z
      .string()
      .min(1)
      .max(PROTOCOL_LIMITS.idChars)
      .regex(/\S/)
      .optional(),
    provider: z.string().min(1).max(120).regex(/\S/),
    model: z.string().min(1).max(240).regex(/\S/),
    baseUrlOrigin: httpUrlSchema.optional()
  })
  .strict();

const runSummaryBaseSchema = z.object({
  id: runIdSchema,
  organizationId: organizationIdSchema,
  projectId: projectIdSchema,
  taskId: taskIdSchema,
  attempt: z.number().int().positive().max(10_000),
  mode: workAgentModeSchema,
  createdAt: isoDateTimeSchema,
  queuedAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.optional()
});

export const queuedRunSummarySchema = runSummaryBaseSchema
  .extend({ status: z.literal('queued') })
  .strict();
const provisioningRunSummarySchema = runSummaryBaseSchema
  .extend({ status: z.literal('provisioning') })
  .strict();
const runningRunSummarySchema = runSummaryBaseSchema
  .extend({ status: z.literal('running') })
  .strict();
const waitingRunSummarySchema = runSummaryBaseSchema
  .extend({ status: z.literal('waiting_for_approval') })
  .strict();
const cancellingRunSummarySchema = runSummaryBaseSchema
  .extend({ status: z.literal('cancelling') })
  .strict();
export const completedRunSummarySchema = runSummaryBaseSchema
  .extend({ status: z.literal('completed'), finishedAt: isoDateTimeSchema })
  .strict();
const cancelledRunSummarySchema = runSummaryBaseSchema
  .extend({ status: z.literal('cancelled'), finishedAt: isoDateTimeSchema })
  .strict();
const failedRunSummarySchema = runSummaryBaseSchema
  .extend({
    status: z.literal('failed'),
    finishedAt: isoDateTimeSchema,
    failure: failureSchema
  })
  .strict();

export const runSummarySchema = z.discriminatedUnion('status', [
  queuedRunSummarySchema,
  provisioningRunSummarySchema,
  runningRunSummarySchema,
  waitingRunSummarySchema,
  cancellingRunSummarySchema,
  completedRunSummarySchema,
  failedRunSummarySchema,
  cancelledRunSummarySchema
]);

const runSnapshotBaseSchema = runSummaryBaseSchema.extend({
  executionProfile: z.literal('work'),
  model: modelSnapshotSchema,
  permissionPolicy: permissionPolicySnapshotSchema,
  resourceLimits: runResourceLimitsSchema,
  usage: runUsageSchema,
  checkpointAvailable: z.boolean(),
  workerGeneration: z.number().int().positive().optional()
});

export const runSnapshotSchema = z.discriminatedUnion('status', [
  runSnapshotBaseSchema.extend({ status: z.literal('queued') }).strict(),
  runSnapshotBaseSchema.extend({ status: z.literal('provisioning') }).strict(),
  runSnapshotBaseSchema.extend({ status: z.literal('running') }).strict(),
  runSnapshotBaseSchema
    .extend({ status: z.literal('waiting_for_approval') })
    .strict(),
  runSnapshotBaseSchema.extend({ status: z.literal('cancelling') }).strict(),
  runSnapshotBaseSchema
    .extend({ status: z.literal('completed'), finishedAt: isoDateTimeSchema })
    .strict(),
  runSnapshotBaseSchema
    .extend({
      status: z.literal('failed'),
      finishedAt: isoDateTimeSchema,
      failure: failureSchema
    })
    .strict(),
  runSnapshotBaseSchema
    .extend({ status: z.literal('cancelled'), finishedAt: isoDateTimeSchema })
    .strict()
]);

export const runPageSchema = paginatedSchema(runSummarySchema);

export const sourceScopeSchema = z.enum(['project', 'task']);

export const sourceOriginSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('upload'), originalFileName: shortLabelSchema })
    .strict(),
  z.object({ kind: z.literal('url'), url: httpUrlSchema }).strict(),
  z
    .object({
      kind: z.literal('repository'),
      gitUrl: z.string().min(1).max(PROTOCOL_LIMITS.urlChars).regex(/\S/),
      revision: z.string().min(1).max(240).regex(/\S/).optional(),
      path: z.string().min(1).max(1_024).regex(/\S/).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal('connector'),
      installationId: z.string().min(1).max(PROTOCOL_LIMITS.idChars),
      externalResourceId: z.string().min(1).max(1_024).regex(/\S/)
    })
    .strict(),
  z
    .object({
      kind: z.literal('generated'),
      runId: runIdSchema,
      artifactId: artifactIdSchema.optional()
    })
    .strict()
]);

const sourceSummaryBaseSchema = z.object({
  id: sourceIdSchema,
  organizationId: organizationIdSchema,
  projectId: projectIdSchema,
  kind: sourceKindSchema,
  status: sourceStatusSchema,
  displayName: shortLabelSchema,
  mimeType: mimeTypeSchema.optional(),
  sizeBytes: byteCountSchema.optional(),
  previousSourceId: sourceIdSchema.optional(),
  createdBy: userIdSchema,
  createdAt: isoDateTimeSchema
});

export const sourceSummarySchema = z.union([
  sourceSummaryBaseSchema.extend({ scope: z.literal('project') }).strict(),
  sourceSummaryBaseSchema
    .extend({ scope: z.literal('task'), taskId: taskIdSchema })
    .strict()
]);

const sourceSnapshotBaseSchema = sourceSummaryBaseSchema.omit({
  status: true,
  sizeBytes: true
}).extend({
  origin: sourceOriginSchema,
  parsedTextAvailable: z.boolean(),
  previewAvailable: z.boolean(),
  diagnostic: optionalSummarySchema.optional()
});

export const sourceSnapshotSchema = z.union([
  sourceSnapshotBaseSchema
    .extend({
      scope: z.literal('project'),
      status: z.literal('ready'),
      sizeBytes: byteCountSchema,
      sha256: sha256Schema
    })
    .strict(),
  sourceSnapshotBaseSchema
    .extend({
      scope: z.literal('task'),
      taskId: taskIdSchema,
      status: z.literal('ready'),
      sizeBytes: byteCountSchema,
      sha256: sha256Schema
    })
    .strict(),
  sourceSnapshotBaseSchema
    .extend({
      scope: z.literal('project'),
      status: z.enum(['uploading', 'processing', 'failed', 'deleted']),
      sizeBytes: byteCountSchema.optional(),
      sha256: sha256Schema.optional()
    })
    .strict(),
  sourceSnapshotBaseSchema
    .extend({
      scope: z.literal('task'),
      taskId: taskIdSchema,
      status: z.enum(['uploading', 'processing', 'failed', 'deleted']),
      sizeBytes: byteCountSchema.optional(),
      sha256: sha256Schema.optional()
    })
    .strict()
]);

export const sourcePageSchema = paginatedSchema(sourceSummarySchema);

const artifactSummaryBaseSchema = z.object({
  id: artifactIdSchema,
  organizationId: organizationIdSchema,
  projectId: projectIdSchema,
  taskId: taskIdSchema,
  runId: runIdSchema,
  kind: artifactKindSchema,
  displayName: shortLabelSchema,
  parentArtifactId: artifactIdSchema.optional(),
  createdAt: isoDateTimeSchema
});

export const readyArtifactSummarySchema = artifactSummaryBaseSchema
  .extend({
    status: z.literal('ready'),
    mimeType: mimeTypeSchema,
    sizeBytes: byteCountSchema
  })
  .strict();

export const artifactSummarySchema = z.discriminatedUnion('status', [
  artifactSummaryBaseSchema
    .extend({
      status: z.literal('pending'),
      mimeType: mimeTypeSchema.optional(),
      sizeBytes: byteCountSchema.optional()
    })
    .strict(),
  readyArtifactSummarySchema,
  artifactSummaryBaseSchema
    .extend({
      status: z.literal('failed'),
      mimeType: mimeTypeSchema.optional(),
      sizeBytes: byteCountSchema.optional()
    })
    .strict(),
  artifactSummaryBaseSchema
    .extend({
      status: z.literal('deleted'),
      mimeType: mimeTypeSchema.optional(),
      sizeBytes: byteCountSchema.optional()
    })
    .strict()
]);

const artifactSnapshotBaseSchema = artifactSummaryBaseSchema.extend({
  sourceIds: z.array(sourceIdSchema).max(PROTOCOL_LIMITS.listItems),
  previewAvailable: z.boolean(),
  downloadPath: z
    .string()
    .min(1)
    .max(2_048)
    .regex(/^\/api\/v2\//)
    .optional(),
  diagnostic: optionalSummarySchema.optional()
});

export const readyArtifactSnapshotSchema = artifactSnapshotBaseSchema
  .extend({
    status: z.literal('ready'),
    mimeType: mimeTypeSchema,
    sizeBytes: byteCountSchema,
    sha256: sha256Schema,
    readyAt: isoDateTimeSchema
  })
  .strict();

export const artifactSnapshotSchema = z.discriminatedUnion('status', [
  artifactSnapshotBaseSchema
    .extend({
      status: z.literal('pending'),
      mimeType: mimeTypeSchema.optional(),
      sizeBytes: byteCountSchema.optional(),
      sha256: sha256Schema.optional()
    })
    .strict(),
  readyArtifactSnapshotSchema,
  artifactSnapshotBaseSchema
    .extend({
      status: z.literal('failed'),
      mimeType: mimeTypeSchema.optional(),
      sizeBytes: byteCountSchema.optional(),
      sha256: sha256Schema.optional()
    })
    .strict(),
  artifactSnapshotBaseSchema
    .extend({
      status: z.literal('deleted'),
      mimeType: mimeTypeSchema.optional(),
      sizeBytes: byteCountSchema.optional(),
      sha256: sha256Schema.optional()
    })
    .strict()
]);

export const artifactPageSchema = paginatedSchema(artifactSummarySchema);

/** `target.type` is the Approval kind, avoiding a second field that can drift. */
export const approvalTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plan'), planDigest: sha256Schema }).strict(),
  z
    .object({
      type: z.literal('tool'),
      toolCallId: z.string().min(1).max(PROTOCOL_LIMITS.idChars),
      toolName: z.string().min(1).max(240).regex(/\S/),
      argumentsHash: sha256Schema
    })
    .strict(),
  z
    .object({
      type: z.literal('external_action'),
      actionType: z.string().min(1).max(240).regex(/\S/),
      idempotencyKey: idempotencyKeySchema,
      argumentsHash: sha256Schema
    })
    .strict(),
  z
    .object({
      type: z.literal('elevated_access'),
      capability: z.string().min(1).max(240).regex(/\S/),
      argumentsHash: sha256Schema
    })
    .strict()
]);

const approvalSummaryBaseSchema = z.object({
  id: approvalIdSchema,
  organizationId: organizationIdSchema,
  projectId: projectIdSchema,
  taskId: taskIdSchema,
  runId: runIdSchema,
  kind: approvalKindSchema,
  scope: z.enum(['run', 'organization']),
  riskLevel: riskLevelSchema,
  actionPreview: summarySchema,
  requestedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema.optional()
});

export const decidedApprovalSummarySchema = z.discriminatedUnion('status', [
  approvalSummaryBaseSchema
    .extend({
      status: z.literal('approved'),
      decidedAt: isoDateTimeSchema,
      decidedBy: userIdSchema,
      decisionIdempotencyKey: idempotencyKeySchema
    })
    .strict(),
  approvalSummaryBaseSchema
    .extend({
      status: z.literal('rejected'),
      decidedAt: isoDateTimeSchema,
      decidedBy: userIdSchema,
      decisionIdempotencyKey: idempotencyKeySchema
    })
    .strict()
]);

export const approvalSummarySchema = z.union([
  approvalSummaryBaseSchema.extend({ status: z.literal('pending') }).strict(),
  decidedApprovalSummarySchema,
  approvalSummaryBaseSchema.extend({ status: z.literal('expired') }).strict(),
  approvalSummaryBaseSchema.extend({ status: z.literal('cancelled') }).strict()
]);

const approvalSnapshotBaseSchema = z.object({
  id: approvalIdSchema,
  organizationId: organizationIdSchema,
  projectId: projectIdSchema,
  taskId: taskIdSchema,
  runId: runIdSchema,
  scope: z.enum(['run', 'organization']),
  riskLevel: riskLevelSchema,
  actionPreview: nonEmptyInlineTextSchema,
  target: approvalTargetSchema,
  requestedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema.optional()
});

const approvedApprovalBaseSchema = approvalSnapshotBaseSchema.extend({
  status: z.literal('approved'),
  decidedAt: isoDateTimeSchema,
  decidedBy: userIdSchema,
  decisionReason: optionalSummarySchema.optional(),
  decisionIdempotencyKey: idempotencyKeySchema
});

export const approvedApprovalSnapshotSchema = z.union([
  approvedApprovalBaseSchema.strict(),
  approvedApprovalBaseSchema
    .extend({
      consumedAt: isoDateTimeSchema,
      consumptionIdempotencyKey: idempotencyKeySchema
    })
    .strict()
]);

export const rejectedApprovalSnapshotSchema = approvalSnapshotBaseSchema
  .extend({
    status: z.literal('rejected'),
    decidedAt: isoDateTimeSchema,
    decidedBy: userIdSchema,
    decisionReason: optionalSummarySchema.optional(),
    decisionIdempotencyKey: idempotencyKeySchema
  })
  .strict();

export const pendingApprovalSnapshotSchema = approvalSnapshotBaseSchema
  .extend({ status: z.literal('pending') })
  .strict();

export const approvalSnapshotSchema = z.union([
  pendingApprovalSnapshotSchema,
  approvedApprovalSnapshotSchema,
  rejectedApprovalSnapshotSchema,
  approvalSnapshotBaseSchema.extend({ status: z.literal('expired') }).strict(),
  approvalSnapshotBaseSchema.extend({ status: z.literal('cancelled') }).strict()
]);

export const approvalPageSchema = paginatedSchema(approvalSummarySchema);

export const notificationSchema = z
  .object({
    id: notificationIdSchema,
    organizationId: organizationIdSchema,
    type: z.enum([
      'approval_required',
      'run_completed',
      'run_failed',
      'artifact_ready',
      'system'
    ]),
    title: shortLabelSchema,
    body: inlineTextSchema,
    projectId: projectIdSchema.optional(),
    taskId: taskIdSchema.optional(),
    runId: runIdSchema.optional(),
    href: z.string().min(1).max(2_048).regex(/^\//).optional(),
    createdAt: isoDateTimeSchema,
    readAt: isoDateTimeSchema.optional()
  })
  .strict();
