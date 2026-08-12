import { z } from 'zod';

import {
  approvalIdSchema,
  artifactIdSchema,
  byteCountSchema,
  failureSchema,
  generationSchema,
  httpUrlSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  leaseIdSchema,
  mimeTypeSchema,
  nonEmptyInlineTextSchema,
  optionalSummarySchema,
  organizationIdSchema,
  projectIdSchema,
  protocolVersionSchema,
  riskLevelSchema,
  resourceIdSchema,
  runIdSchema,
  sequenceSchema,
  sha256Schema,
  shortLabelSchema,
  sourceIdSchema,
  summarySchema,
  taskIdSchema,
  taskMessageIdSchema,
  toolCallIdSchema,
  workerIdSchema,
  workerSessionIdSchema
} from './commonSchemas';
import { PROTOCOL_LIMITS } from './limits';
import {
  approvalDecisionSchema,
  approvalTargetSchema,
  artifactKindSchema,
  modelSnapshotSchema,
  pendingApprovalSnapshotSchema,
  permissionPolicySnapshotSchema,
  readyArtifactSnapshotSchema,
  runResourceLimitsSchema,
  sourceKindSchema,
  taskMessageSchema,
  taskTypeSchema
} from './resourceSchemas';
import {
  progressPhaseSchema,
  publicToolCallSchema
} from './publicEventSchemas';

export const internalHeaderSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(PROTOCOL_LIMITS.headerNameChars)
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
    value: z
      .string()
      .max(PROTOCOL_LIMITS.headerValueChars)
      .regex(/^[^\r\n]*$/)
  })
  .strict();

export const runSpecMessageSchema = z
  .object({
    id: taskMessageIdSchema,
    role: z.enum(['user', 'agent', 'system']),
    text: nonEmptyInlineTextSchema,
    createdAt: isoDateTimeSchema
  })
  .strict();

export const runSpecSourceSchema = z
  .object({
    id: sourceIdSchema,
    kind: sourceKindSchema,
    displayName: shortLabelSchema,
    fileName: z
      .string()
      .min(1)
      .max(240)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/),
    mimeType: mimeTypeSchema,
    sizeBytes: byteCountSchema,
    sha256: sha256Schema,
    downloadUrl: httpUrlSchema,
    downloadHeaders: z.array(internalHeaderSchema).max(PROTOCOL_LIMITS.headerCount),
    expiresAt: isoDateTimeSchema
  })
  .strict();

export const runSpecRepositorySchema = z
  .object({
    gitUrl: z.string().min(1).max(PROTOCOL_LIMITS.urlChars),
    revision: z.string().min(1).max(240),
    credentialHandle: resourceIdSchema.optional()
  })
  .strict();

export const runSpecPolicySchema = z
  .object({
    permissionPolicy: permissionPolicySnapshotSchema,
    allowedToolNames: z
      .array(z.string().min(1).max(240))
      .max(PROTOCOL_LIMITS.listItems),
    connectorInstallationIds: z
      .array(resourceIdSchema)
      .max(PROTOCOL_LIMITS.listItems),
    externalActions: z.enum(['require_approval', 'draft_only', 'deny']),
    networkAccess: z.enum(['restricted', 'connector_proxy_only', 'disabled'])
  })
  .strict();

export const runSpecWorkspaceSchema = z
  .object({
    root: z.string().regex(/^\/work$/).max(4_096),
    inputDirectory: z
      .string()
      .regex(/^\/work\/input(?:\/(?!\.{1,2}(?:\/|$))[^/\u0000]+)*$/)
      .max(4_096),
    outputDirectory: z
      .string()
      .regex(/^\/work\/output(?:\/(?!\.{1,2}(?:\/|$))[^/\u0000]+)*$/)
      .max(4_096),
    checkpointDirectory: z
      .string()
      .regex(/^\/work\/checkpoint(?:\/(?!\.{1,2}(?:\/|$))[^/\u0000]+)*$/)
      .max(4_096),
    repositoryDirectory: z
      .string()
      .regex(/^\/work\/repository(?:\/(?!\.{1,2}(?:\/|$))[^/\u0000]+)*$/)
      .max(4_096)
      .optional()
  })
  .strict();

/** Immutable, run-scoped contract returned after a worker lease is accepted. */
export const runSpecSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    organizationId: organizationIdSchema,
    projectId: projectIdSchema,
    taskId: taskIdSchema,
    runId: runIdSchema,
    generation: generationSchema,
    leaseId: leaseIdSchema,
    leaseExpiresAt: isoDateTimeSchema,
    issuedAt: isoDateTimeSchema,
    task: z
      .object({
        type: taskTypeSchema,
        title: shortLabelSchema,
        objective: nonEmptyInlineTextSchema,
        constraints: z.array(nonEmptyInlineTextSchema).max(50),
        acceptanceCriteria: z.array(nonEmptyInlineTextSchema).max(50),
        messages: z
          .array(runSpecMessageSchema)
          .max(PROTOCOL_LIMITS.snapshotListItems)
      })
      .strict(),
    sources: z.array(runSpecSourceSchema).max(PROTOCOL_LIMITS.listItems),
    repository: runSpecRepositorySchema.optional(),
    model: modelSnapshotSchema.extend({
      credentialHandle: resourceIdSchema
    }).strict(),
    mode: z.enum(['auto', 'plan']),
    executionProfile: z.literal('work'),
    policy: runSpecPolicySchema,
    resourceLimits: runResourceLimitsSchema,
    workspace: runSpecWorkspaceSchema,
    resumeCheckpointKey: z.string().min(1).max(1_024).optional()
  })
  .strict();

export const terminalRunEventDataSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('completed'),
      summary: summarySchema,
      finalMessageId: taskMessageIdSchema.optional(),
      finishedAt: isoDateTimeSchema
    })
    .strict(),
  z
    .object({
      status: z.literal('failed'),
      summary: summarySchema,
      finalMessageId: taskMessageIdSchema.optional(),
      failure: failureSchema,
      finishedAt: isoDateTimeSchema
    })
    .strict(),
  z
    .object({
      status: z.literal('cancelled'),
      summary: summarySchema,
      finalMessageId: taskMessageIdSchema.optional(),
      finishedAt: isoDateTimeSchema
    })
    .strict()
]);

export const internalRunEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('run.started'),
      startedAt: isoDateTimeSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('run.progress'),
      phase: progressPhaseSchema,
      message: summarySchema,
      stepId: resourceIdSchema.optional(),
      completedUnits: z.number().int().nonnegative().optional(),
      totalUnits: z.number().int().positive().optional(),
      percent: z.number().min(0).max(100).optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('run.message_delta'),
      messageId: taskMessageIdSchema,
      index: sequenceSchema,
      delta: z.string().min(1).max(PROTOCOL_LIMITS.messageDeltaChars).regex(/\S/)
    })
    .strict(),
  z
    .object({
      type: z.literal('run.message_final'),
      message: taskMessageSchema.omit({ runId: true })
    })
    .strict(),
  z
    .object({
      type: z.literal('run.tool_started'),
      tool: publicToolCallSchema.extend({ status: z.literal('running') }).strict()
    })
    .strict(),
  z
    .object({
      type: z.literal('run.tool_completed'),
      tool: publicToolCallSchema
        .extend({
          status: z.enum(['completed', 'failed', 'denied', 'cancelled']),
          finishedAt: isoDateTimeSchema
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal('run.approval_requested'),
      approval: pendingApprovalSnapshotSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('run.checkpoint_updated'),
      checkpointKey: z.string().min(1).max(1_024),
      sha256: sha256Schema,
      sizeBytes: byteCountSchema,
      completedThroughSeq: sequenceSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('run.terminal'),
      terminal: terminalRunEventDataSchema
    })
    .strict()
]);

/** `(runId, generation, seq)` is the idempotency key for execution events. */
export const workerRunEventEnvelopeSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    runId: runIdSchema,
    generation: generationSchema,
    seq: sequenceSchema,
    timestamp: isoDateTimeSchema,
    event: internalRunEventSchema
  })
  .strict();

const messageBase = {
  protocolVersion: protocolVersionSchema,
  messageId: resourceIdSchema,
  sentAt: isoDateTimeSchema
};

export const workerRegisterMessageSchema = z
  .object({
    ...messageBase,
    type: z.literal('worker.register'),
    workerId: workerIdSchema,
    runId: runIdSchema,
    generation: generationSchema,
    leaseId: leaseIdSchema,
    workerVersion: z.string().min(1).max(120),
    capabilities: z
      .object({
        checkpointResume: z.boolean(),
        artifactUpload: z.boolean(),
        connectorProxy: z.boolean()
      })
      .strict()
  })
  .strict();

export const workerRegisteredMessageSchema = z
  .object({
    ...messageBase,
    type: z.literal('worker.registered'),
    workerSessionId: workerSessionIdSchema,
    heartbeatIntervalMs: z.number().int().min(1_000).max(60_000),
    runSpec: runSpecSchema
  })
  .strict();

export const workerHeartbeatMessageSchema = z
  .object({
    ...messageBase,
    type: z.literal('worker.heartbeat'),
    workerSessionId: workerSessionIdSchema,
    runId: runIdSchema,
    generation: generationSchema,
    leaseId: leaseIdSchema,
    lastEmittedSeq: z.number().int().nonnegative(),
    usage: z
      .object({
        cpuMillis: z.number().int().nonnegative(),
        memoryBytes: byteCountSchema,
        diskBytes: byteCountSchema
      })
      .strict()
  })
  .strict();

export const leaseRenewedMessageSchema = z
  .object({
    ...messageBase,
    type: z.literal('lease.renewed'),
    workerSessionId: workerSessionIdSchema,
    runId: runIdSchema,
    generation: generationSchema,
    leaseId: leaseIdSchema,
    leaseExpiresAt: isoDateTimeSchema
  })
  .strict();

export const leaseReleaseMessageSchema = z
  .object({
    ...messageBase,
    type: z.literal('lease.release'),
    workerSessionId: workerSessionIdSchema,
    runId: runIdSchema,
    generation: generationSchema,
    leaseId: leaseIdSchema,
    reason: z.enum(['terminal', 'shutdown', 'lost', 'error'])
  })
  .strict();

export const workerEventMessageSchema = z
  .object({
    ...messageBase,
    type: z.literal('worker.event'),
    envelope: workerRunEventEnvelopeSchema
  })
  .strict();

export const workerEventAckMessageSchema = z
  .object({
    ...messageBase,
    type: z.literal('worker.event_ack'),
    runId: runIdSchema,
    generation: generationSchema,
    acceptedThroughSeq: sequenceSchema
  })
  .strict();

export const runCancelMessageSchema = z
  .object({
    ...messageBase,
    type: z.literal('run.cancel'),
    runId: runIdSchema,
    generation: generationSchema,
    reason: summarySchema
  })
  .strict();

export const approvalDecisionMessageSchema = z
  .object({
    ...messageBase,
    type: z.literal('approval.decision'),
    decisionId: idempotencyKeySchema,
    runId: runIdSchema,
    generation: generationSchema,
    approvalId: approvalIdSchema,
    decision: approvalDecisionSchema,
    reason: optionalSummarySchema.optional(),
    decidedAt: isoDateTimeSchema,
    requestHash: sha256Schema
  })
  .strict();

export const artifactReserveMessageSchema = z
  .object({
    ...messageBase,
    type: z.literal('artifact.reserve'),
    idempotencyKey: idempotencyKeySchema,
    runId: runIdSchema,
    generation: generationSchema,
    taskId: taskIdSchema,
    kind: artifactKindSchema,
    displayName: shortLabelSchema,
    mimeType: mimeTypeSchema,
    sizeBytes: byteCountSchema,
    sha256: sha256Schema,
    parentArtifactId: artifactIdSchema.optional(),
    sourceIds: z.array(sourceIdSchema).max(PROTOCOL_LIMITS.listItems)
  })
  .strict();

const artifactUploadInstructionSchema = z
  .object({
    method: z.enum(['PUT', 'POST']),
    url: httpUrlSchema,
    headers: z.array(internalHeaderSchema).max(PROTOCOL_LIMITS.headerCount),
    expiresAt: isoDateTimeSchema
  })
  .strict();

const artifactReservedBase = {
  ...messageBase,
  type: z.literal('artifact.reserved'),
  idempotencyKey: idempotencyKeySchema,
  runId: runIdSchema,
  generation: generationSchema,
  artifactId: artifactIdSchema
};

export const artifactReservedMessageSchema = z.discriminatedUnion(
  'alreadyCommitted',
  [
    z
      .object({
        ...artifactReservedBase,
        alreadyCommitted: z.literal(false),
        upload: artifactUploadInstructionSchema
      })
      .strict(),
    z
      .object({
        ...artifactReservedBase,
        alreadyCommitted: z.literal(true)
      })
      .strict()
  ]
);

export const artifactCommitMessageSchema = z
  .object({
    ...messageBase,
    type: z.literal('artifact.commit'),
    idempotencyKey: idempotencyKeySchema,
    runId: runIdSchema,
    generation: generationSchema,
    artifactId: artifactIdSchema,
    sizeBytes: byteCountSchema,
    sha256: sha256Schema,
    uploadEtag: z.string().min(1).max(512).regex(/\S/).optional()
  })
  .strict();

const committedArtifactSchema = readyArtifactSnapshotSchema.omit({ runId: true });
export const artifactCommittedMessageSchema = z
  .object({
    ...messageBase,
    type: z.literal('artifact.committed'),
    idempotencyKey: idempotencyKeySchema,
    runId: runIdSchema,
    generation: generationSchema,
    artifact: committedArtifactSchema
  })
  .strict();

export const internalProtocolErrorMessageSchema = z
  .object({
    ...messageBase,
    type: z.literal('protocol.error'),
    requestMessageId: resourceIdSchema.optional(),
    code: z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/),
    message: summarySchema,
    retryable: z.boolean()
  })
  .strict();

export const internalWorkerMessageSchema = z.union([
  workerRegisterMessageSchema,
  workerRegisteredMessageSchema,
  workerHeartbeatMessageSchema,
  leaseRenewedMessageSchema,
  leaseReleaseMessageSchema,
  workerEventMessageSchema,
  workerEventAckMessageSchema,
  runCancelMessageSchema,
  approvalDecisionMessageSchema,
  artifactReserveMessageSchema,
  artifactReservedMessageSchema,
  artifactCommitMessageSchema,
  artifactCommittedMessageSchema,
  internalProtocolErrorMessageSchema
]);

// Exported primitives used by Worker implementations to build approval requests.
export const internalApprovalRequestSchema = z
  .object({
    approvalId: approvalIdSchema,
    scope: z.enum(['run', 'organization']),
    riskLevel: riskLevelSchema,
    actionPreview: nonEmptyInlineTextSchema,
    target: approvalTargetSchema,
    expiresAt: isoDateTimeSchema.optional()
  })
  .strict();

export const internalToolResultSchema = z
  .object({
    toolCallId: toolCallIdSchema,
    status: z.enum(['completed', 'failed', 'denied', 'cancelled']),
    summary: optionalSummarySchema,
    outputArtifactIds: z.array(artifactIdSchema).max(PROTOCOL_LIMITS.listItems)
  })
  .strict();
