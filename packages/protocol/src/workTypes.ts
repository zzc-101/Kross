import type { z } from 'zod';

import type {
  approvalDecisionMessageSchema,
  artifactCommitMessageSchema,
  artifactReserveMessageSchema,
  internalRunEventSchema,
  internalWorkerMessageSchema,
  runSpecSchema,
  workerRunEventEnvelopeSchema
} from './internalWorkerSchemas';
import type {
  publicEventEnvelopeSchema,
  publicEventPageSchema,
  publicEventSchema,
  publicToolCallSchema
} from './publicEventSchemas';
import type {
  approvalSnapshotSchema,
  approvalSummarySchema,
  artifactSnapshotSchema,
  artifactSummarySchema,
  notificationSchema,
  runSnapshotSchema,
  runSummarySchema,
  sourceSnapshotSchema,
  sourceSummarySchema,
  taskMessageSchema,
  taskSnapshotSchema,
  taskSummarySchema
} from './resourceSchemas';

export type TaskSummary = z.infer<typeof taskSummarySchema>;
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;
export type TaskMessage = z.infer<typeof taskMessageSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;
export type SourceSummary = z.infer<typeof sourceSummarySchema>;
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;
export type ArtifactSnapshot = z.infer<typeof artifactSnapshotSchema>;
export type ApprovalSummary = z.infer<typeof approvalSummarySchema>;
export type ApprovalSnapshot = z.infer<typeof approvalSnapshotSchema>;
export type Notification = z.infer<typeof notificationSchema>;

export type PublicEvent = z.infer<typeof publicEventSchema>;
export type PublicEventEnvelope = z.infer<typeof publicEventEnvelopeSchema>;
export type PublicEventPage = z.infer<typeof publicEventPageSchema>;
export type PublicToolCall = z.infer<typeof publicToolCallSchema>;

export type RunSpec = z.infer<typeof runSpecSchema>;
export type InternalRunEvent = z.infer<typeof internalRunEventSchema>;
export type WorkerRunEventEnvelope = z.infer<
  typeof workerRunEventEnvelopeSchema
>;
export type InternalWorkerMessage = z.infer<typeof internalWorkerMessageSchema>;
export type ApprovalDecisionMessage = z.infer<
  typeof approvalDecisionMessageSchema
>;
export type ArtifactReserveMessage = z.infer<
  typeof artifactReserveMessageSchema
>;
export type ArtifactCommitMessage = z.infer<typeof artifactCommitMessageSchema>;

