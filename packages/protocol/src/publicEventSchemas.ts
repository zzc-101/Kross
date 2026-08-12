import { z } from 'zod';

import {
  artifactIdSchema,
  isoDateTimeSchema,
  messageDeltaSchema,
  opaqueCursorSchema,
  optionalSummarySchema,
  organizationIdSchema,
  projectIdSchema,
  protocolVersionSchema,
  runIdSchema,
  sequenceSchema,
  shortLabelSchema,
  summarySchema,
  taskIdSchema,
  taskMessageIdSchema,
  toolCallIdSchema
} from './commonSchemas';
import { PROTOCOL_LIMITS } from './limits';
import {
  completedRunSummarySchema,
  decidedApprovalSummarySchema,
  notificationSchema,
  pendingApprovalSnapshotSchema,
  queuedRunSummarySchema,
  readyArtifactSummarySchema,
  runStatusSchema,
  taskMessageSchema,
  taskSummarySchema
} from './resourceSchemas';

export const progressPhaseSchema = z.enum([
  'planning',
  'gathering_sources',
  'executing',
  'using_tool',
  'waiting_for_approval',
  'creating_artifact',
  'verifying',
  'finalizing'
]);

export const publicToolStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'denied',
  'cancelled'
]);

export const publicToolCallSchema = z
  .object({
    toolCallId: toolCallIdSchema,
    name: z.string().min(1).max(240).regex(/\S/),
    displayName: shortLabelSchema,
    status: publicToolStatusSchema,
    risk: z.enum(['low', 'medium', 'high', 'critical']),
    summary: optionalSummarySchema.optional(),
    startedAt: isoDateTimeSchema,
    finishedAt: isoDateTimeSchema.optional(),
    durationMs: z.number().int().nonnegative().optional()
  })
  .strict();

const runEventContextShape = {
  organizationId: organizationIdSchema,
  projectId: projectIdSchema,
  taskId: taskIdSchema,
  runId: runIdSchema
};

export const taskCreatedEventSchema = z
  .object({ type: z.literal('task.created'), data: taskSummarySchema })
  .strict();
export const taskUpdatedEventSchema = z
  .object({ type: z.literal('task.updated'), data: taskSummarySchema })
  .strict();
export const runQueuedEventSchema = z
  .object({ type: z.literal('run.queued'), data: queuedRunSummarySchema })
  .strict();
export const runStatusChangedEventSchema = z
  .object({
    type: z.literal('run.status_changed'),
    data: z
      .object({
        ...runEventContextShape,
        previousStatus: runStatusSchema,
        status: runStatusSchema,
        reason: optionalSummarySchema.optional(),
        changedAt: isoDateTimeSchema
      })
      .strict()
  })
  .strict();
export const runProgressEventSchema = z
  .object({
    type: z.literal('run.progress'),
    data: z
      .object({
        ...runEventContextShape,
        phase: progressPhaseSchema,
        message: summarySchema,
        stepId: z.string().min(1).max(PROTOCOL_LIMITS.idChars).optional(),
        completedUnits: z.number().int().nonnegative().optional(),
        totalUnits: z.number().int().positive().optional(),
        percent: z.number().min(0).max(100).optional()
      })
      .strict()
  })
  .strict();
export const runMessageDeltaEventSchema = z
  .object({
    type: z.literal('run.message_delta'),
    data: z
      .object({
        ...runEventContextShape,
        messageId: taskMessageIdSchema,
        index: sequenceSchema,
        delta: messageDeltaSchema
      })
      .strict()
  })
  .strict();

const runTaskMessageSchema = taskMessageSchema
  .extend({ runId: runIdSchema })
  .strict();
export const runMessageCreatedEventSchema = z
  .object({ type: z.literal('run.message_created'), data: runTaskMessageSchema })
  .strict();

const runningToolEventDataSchema = publicToolCallSchema
  .extend({
    ...runEventContextShape,
    status: z.literal('running')
  })
  .strict();
const completedToolEventDataSchema = publicToolCallSchema
  .extend({
    ...runEventContextShape,
    status: z.enum(['completed', 'failed', 'denied', 'cancelled']),
    finishedAt: isoDateTimeSchema
  })
  .strict();
export const runToolStartedEventSchema = z
  .object({ type: z.literal('run.tool_started'), data: runningToolEventDataSchema })
  .strict();
export const runToolCompletedEventSchema = z
  .object({
    type: z.literal('run.tool_completed'),
    data: completedToolEventDataSchema
  })
  .strict();
export const runApprovalRequestedEventSchema = z
  .object({
    type: z.literal('run.approval_requested'),
    data: pendingApprovalSnapshotSchema
  })
  .strict();
export const approvalDecidedEventSchema = z
  .object({
    type: z.literal('approval.decided'),
    data: decidedApprovalSummarySchema
  })
  .strict();
export const artifactReadyEventSchema = z
  .object({ type: z.literal('artifact.ready'), data: readyArtifactSummarySchema })
  .strict();
export const runCompletedEventSchema = z
  .object({ type: z.literal('run.completed'), data: completedRunSummarySchema })
  .strict();
export const notificationCreatedEventSchema = z
  .object({ type: z.literal('notification.created'), data: notificationSchema })
  .strict();

/**
 * Public SSE events contain one authoritative resource context inside `data`.
 * The envelope deliberately does not repeat tenant/run IDs, eliminating a
 * class of cross-tenant routing mismatches. REST snapshots remain authoritative.
 */
export const publicEventSchema = z.discriminatedUnion('type', [
  taskCreatedEventSchema,
  taskUpdatedEventSchema,
  runQueuedEventSchema,
  runStatusChangedEventSchema,
  runProgressEventSchema,
  runMessageDeltaEventSchema,
  runMessageCreatedEventSchema,
  runToolStartedEventSchema,
  runToolCompletedEventSchema,
  runApprovalRequestedEventSchema,
  approvalDecidedEventSchema,
  artifactReadyEventSchema,
  runCompletedEventSchema,
  notificationCreatedEventSchema
]);

export const publicEventEnvelopeSchema = z
  .object({
    protocolVersion: protocolVersionSchema,
    eventId: opaqueCursorSchema,
    timestamp: isoDateTimeSchema,
    event: publicEventSchema
  })
  .strict();

export const publicEventPageSchema = z
  .object({
    events: z.array(publicEventEnvelopeSchema).max(PROTOCOL_LIMITS.eventBatchItems),
    nextCursor: opaqueCursorSchema.optional(),
    hasMore: z.boolean()
  })
  .strict();

export const artifactContentReferenceSchema = z
  .object({
    artifactId: artifactIdSchema,
    contentPath: z.string().min(1).max(2_048).regex(/^\/api\/v2\//),
    expiresAt: isoDateTimeSchema.optional()
  })
  .strict();
