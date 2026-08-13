import {
  approvalPageSchema,
  artifactPageSchema,
  isoDateTimeSchema,
  resourceIdSchema,
  runStatusSchema,
  runSnapshotSchema,
  sourcePageSchema,
  taskMessagePageSchema,
  taskPageSchema,
  taskSnapshotSchema,
  taskStatusSchema,
  taskTypeSchema
} from '@kross/protocol';
import { z } from 'zod';

export const identitySchema = z
  .object({ userId: resourceIdSchema, displayName: z.string().min(1).max(200) })
  .strict();
export const membershipSchema = z
  .object({
    id: resourceIdSchema,
    organizationId: resourceIdSchema,
    userId: resourceIdSchema,
    role: z.enum(['owner', 'admin', 'member', 'viewer']),
    status: z.literal('active'),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict();
export const bootstrapSchema = z
  .object({ user: identitySchema, memberships: z.array(membershipSchema) })
  .strict();

export const projectSchema = z
  .object({
    id: resourceIdSchema,
    organizationId: resourceIdSchema,
    kind: z.enum(['general', 'repository']),
    name: z.string().min(1).max(200),
    description: z.string().max(10_000).optional(),
    status: z.enum(['active', 'archived', 'deleted']),
    createdBy: resourceIdSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict();
export const projectListSchema = z.object({ items: z.array(projectSchema) }).strict();

// Temporary normalization for the current P1 server. All exported values are
// re-parsed into Protocol v2 snapshots before entering UI state.
export const serverTaskRecordSchema = z
  .object({
    id: resourceIdSchema,
    organizationId: resourceIdSchema,
    projectId: resourceIdSchema,
    type: taskTypeSchema,
    status: taskStatusSchema,
    title: z.string().min(1),
    objective: z.string(),
    constraints: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
    latestRunId: resourceIdSchema.optional(),
    createdBy: resourceIdSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict();
export const serverRunRecordSchema = z
  .object({
    id: resourceIdSchema,
    organizationId: resourceIdSchema,
    projectId: resourceIdSchema,
    taskId: resourceIdSchema,
    attempt: z.number().int().positive(),
    status: runStatusSchema,
    mode: z.enum(['auto', 'plan']),
    queuedAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.optional(),
    finishedAt: isoDateTimeSchema.optional(),
    createdBy: resourceIdSchema
  })
  .strict();
export const serverApprovalRecordSchema = z
  .object({
    id: resourceIdSchema,
    organization_id: resourceIdSchema,
    project_id: resourceIdSchema,
    task_id: resourceIdSchema,
    run_id: resourceIdSchema,
    kind: z.enum(['plan', 'tool', 'external_action', 'elevated_access']),
    scope: z.enum(['run', 'organization']),
    risk_level: z.enum(['low', 'medium', 'high', 'critical']),
    action_preview: z.string().min(1),
    status: z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']),
    requested_at: isoDateTimeSchema,
    expires_at: isoDateTimeSchema.nullish(),
    decided_at: isoDateTimeSchema.nullish(),
    decided_by: resourceIdSchema.nullish(),
    decision_idempotency_key: z.string().min(1).nullish()
  })
  .passthrough();

export const serverSourceRecordSchema = z.object({
  id: resourceIdSchema,
  organization_id: resourceIdSchema,
  project_id: resourceIdSchema,
  task_id: resourceIdSchema.nullish(),
  kind: z.enum(['upload', 'url', 'repository', 'connector', 'generated']),
  scope: z.enum(['project', 'task']),
  status: z.enum(['uploading', 'processing', 'ready', 'failed', 'deleted']),
  display_name: z.string().min(1).max(500),
  mime_type: z.string().nullish(),
  size_bytes: z.union([z.number(), z.string()]).nullish(),
  previous_source_id: resourceIdSchema.nullish(),
  created_by: resourceIdSchema,
  created_at: isoDateTimeSchema
}).passthrough();

export const serverArtifactRecordSchema = z.object({
  id: resourceIdSchema,
  organization_id: resourceIdSchema,
  project_id: resourceIdSchema,
  task_id: resourceIdSchema,
  run_id: resourceIdSchema,
  kind: z.enum(['document', 'spreadsheet', 'presentation', 'image', 'data', 'archive', 'code', 'other']),
  status: z.enum(['pending', 'ready', 'failed', 'deleted']),
  display_name: z.string().min(1).max(500),
  mime_type: z.string().nullish(),
  size_bytes: z.union([z.number(), z.string()]).nullish(),
  previous_artifact_id: resourceIdSchema.nullish(),
  created_at: isoDateTimeSchema
}).passthrough();

export const sourceUploadReservationSchema = serverSourceRecordSchema.extend({
  upload: z.object({
    method: z.literal('PUT'),
    url: z.string().url(),
    headers: z.array(z.object({ name: z.string().min(1), value: z.string() }).strict()),
    expiresAt: isoDateTimeSchema
  }).strict()
}).passthrough();

export const publicSchemas = {
  bootstrap: bootstrapSchema,
  projects: projectListSchema,
  project: projectSchema,
  taskPage: taskPageSchema,
  task: taskSnapshotSchema,
  messages: taskMessagePageSchema,
  run: runSnapshotSchema,
  sources: sourcePageSchema,
  artifacts: artifactPageSchema,
  approvals: approvalPageSchema
} as const;

export type Bootstrap = z.infer<typeof bootstrapSchema>;
export type Project = z.infer<typeof projectSchema>;
