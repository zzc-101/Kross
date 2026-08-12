import { z } from 'zod';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema)
  ])
);

/** Opaque resource identifier shared with the browser-safe Protocol contract. */
export const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const nonEmptyStringSchema = z.string().trim().min(1);
export const isoDateTimeSchema = z.string().datetime({ offset: true });
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const organizationStatuses = ['active', 'suspended', 'deleted'] as const;
export const membershipRoles = ['owner', 'admin', 'member', 'viewer'] as const;
export const membershipStatuses = ['invited', 'active', 'disabled'] as const;
export const projectKinds = ['general', 'repository'] as const;
export const projectStatuses = ['active', 'archived', 'deleted'] as const;
export const sourceKinds = [
  'upload',
  'url',
  'repository',
  'connector',
  'generated'
] as const;
export const sourceScopes = ['project', 'task'] as const;
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
export const taskMessageRoles = ['user', 'agent', 'system'] as const;
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
export const riskLevels = ['low', 'medium', 'high', 'critical'] as const;
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
export const connectorInstallationStatuses = [
  'pending',
  'active',
  'error',
  'revoked'
] as const;
export const scheduleStatuses = ['active', 'paused', 'deleted'] as const;
export const scheduleConcurrencyPolicies = ['skip', 'queue', 'replace'] as const;
export const externalActionPolicies = ['draft_only', 'require_approval'] as const;

export const organizationStatusSchema = z.enum(organizationStatuses);
export const membershipRoleSchema = z.enum(membershipRoles);
export const membershipStatusSchema = z.enum(membershipStatuses);
export const projectKindSchema = z.enum(projectKinds);
export const projectStatusSchema = z.enum(projectStatuses);
export const sourceKindSchema = z.enum(sourceKinds);
export const sourceScopeSchema = z.enum(sourceScopes);
export const sourceStatusSchema = z.enum(sourceStatuses);
export const taskTypeSchema = z.enum(taskTypes);
export const taskStatusSchema = z.enum(taskStatuses);
export const taskMessageRoleSchema = z.enum(taskMessageRoles);
export const runStatusSchema = z.enum(runStatuses);
export const approvalKindSchema = z.enum(approvalKinds);
export const approvalStatusSchema = z.enum(approvalStatuses);
export const riskLevelSchema = z.enum(riskLevels);
export const artifactKindSchema = z.enum(artifactKinds);
export const artifactStatusSchema = z.enum(artifactStatuses);
export const connectorInstallationStatusSchema = z.enum(connectorInstallationStatuses);
export const scheduleStatusSchema = z.enum(scheduleStatuses);
export const scheduleConcurrencyPolicySchema = z.enum(scheduleConcurrencyPolicies);
export const externalActionPolicySchema = z.enum(externalActionPolicies);

export const approvalPolicySchema = z
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
    allowedConnectorScopes: z.array(nonEmptyStringSchema),
    approvalPolicy: approvalPolicySchema
  })
  .strict();

export const organizationSchema = z
  .object({
    id: identifierSchema,
    slug: z.string().trim().min(1).max(100),
    name: nonEmptyStringSchema.max(200),
    status: organizationStatusSchema,
    defaultTimezone: nonEmptyStringSchema,
    dataRetentionDays: z.number().int().positive().nullable(),
    approvalPolicy: approvalPolicySchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict();

export const createOrganizationInputSchema = organizationSchema
  .pick({
    slug: true,
    name: true,
    defaultTimezone: true,
    dataRetentionDays: true,
    approvalPolicy: true
  })
  .strict();

export const membershipSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    userId: identifierSchema,
    role: membershipRoleSchema,
    status: membershipStatusSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict();

export const createMembershipInputSchema = membershipSchema
  .pick({ userId: true, role: true })
  .strict();

const projectBaseSchema = z.object({
  id: identifierSchema,
  organizationId: identifierSchema,
  name: nonEmptyStringSchema.max(200),
  description: z.string().max(10_000).optional(),
  status: projectStatusSchema,
  defaultModelProfileId: identifierSchema.optional(),
  defaultPermissionPolicy: permissionPolicySnapshotSchema,
  defaultTaskType: taskTypeSchema,
  createdBy: identifierSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const repositoryBindingSchema = z
  .object({
    gitUrl: nonEmptyStringSchema,
    defaultBranch: nonEmptyStringSchema,
    credentialRef: identifierSchema.optional()
  })
  .strict();

export const projectSchema = z.discriminatedUnion('kind', [
  projectBaseSchema.extend({ kind: z.literal('general') }).strict(),
  projectBaseSchema
    .extend({
      kind: z.literal('repository'),
      repository: repositoryBindingSchema
    })
    .strict()
]);

const createProjectBaseSchema = projectBaseSchema.pick({
  name: true,
  description: true,
  defaultModelProfileId: true,
  defaultPermissionPolicy: true,
  defaultTaskType: true
});

export const createProjectInputSchema = z.discriminatedUnion('kind', [
  createProjectBaseSchema.extend({ kind: z.literal('general') }).strict(),
  createProjectBaseSchema
    .extend({ kind: z.literal('repository'), repository: repositoryBindingSchema })
    .strict()
]);

export const sourceOriginSchema = z
  .object({
    label: nonEmptyStringSchema,
    locator: nonEmptyStringSchema.optional(),
    connectorInstallationId: identifierSchema.optional(),
    metadata: z.record(jsonValueSchema).optional()
  })
  .strict();

const sourceBaseSchema = z.object({
  id: identifierSchema,
  organizationId: identifierSchema,
  projectId: identifierSchema,
  kind: sourceKindSchema,
  status: sourceStatusSchema,
  displayName: nonEmptyStringSchema.max(500),
  mimeType: nonEmptyStringSchema.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: sha256Schema.optional(),
  blobKey: nonEmptyStringSchema.optional(),
  externalLocator: nonEmptyStringSchema.optional(),
  origin: sourceOriginSchema,
  previousSourceId: identifierSchema.optional(),
  parsedTextBlobKey: nonEmptyStringSchema.optional(),
  citationIndexBlobKey: nonEmptyStringSchema.optional(),
  diagnosticsBlobKey: nonEmptyStringSchema.optional(),
  failureCategory: nonEmptyStringSchema.optional(),
  createdBy: identifierSchema,
  createdAt: isoDateTimeSchema
});

function validateReadySource(
  source: {
    status: (typeof sourceStatuses)[number];
    sizeBytes?: number;
    sha256?: string;
    blobKey?: string;
    externalLocator?: string;
  },
  context: z.RefinementCtx
): void {
  if (
    source.status === 'ready' &&
    (source.sizeBytes === undefined ||
      source.sha256 === undefined ||
      (source.blobKey === undefined && source.externalLocator === undefined))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'Ready Source requires sizeBytes, sha256, and an immutable content locator'
    });
  }
}

export const sourceSchema = z
  .discriminatedUnion('scope', [
    sourceBaseSchema.extend({ scope: z.literal('project') }).strict(),
    sourceBaseSchema.extend({ scope: z.literal('task'), taskId: identifierSchema }).strict()
  ])
  .superRefine(validateReadySource);

const createSourceBaseSchema = sourceBaseSchema.pick({
  projectId: true,
  kind: true,
  displayName: true,
  mimeType: true,
  origin: true,
  previousSourceId: true
});

export const createSourceInputSchema = z.discriminatedUnion('scope', [
  createSourceBaseSchema.extend({ scope: z.literal('project') }).strict(),
  createSourceBaseSchema
    .extend({ scope: z.literal('task'), taskId: identifierSchema })
    .strict()
]);

export const completeSourceUploadInputSchema = z
  .object({
    sourceId: identifierSchema,
    sizeBytes: z.number().int().nonnegative(),
    sha256: sha256Schema
  })
  .strict();

export const finalizeSourceInputSchema = z.union([
  z
      .object({
        sourceId: identifierSchema,
        status: z.literal('ready'),
        sizeBytes: z.number().int().nonnegative(),
        sha256: sha256Schema,
        blobKey: nonEmptyStringSchema.optional(),
        externalLocator: nonEmptyStringSchema.optional(),
        parsedTextBlobKey: nonEmptyStringSchema.optional(),
        citationIndexBlobKey: nonEmptyStringSchema.optional(),
        diagnosticsBlobKey: nonEmptyStringSchema.optional()
      })
      .strict()
      .refine((input) => input.blobKey !== undefined || input.externalLocator !== undefined, {
        message: 'Ready Source requires an immutable content locator'
      }),
  z
      .object({
        sourceId: identifierSchema,
        status: z.literal('failed'),
        failureCategory: nonEmptyStringSchema,
        diagnosticsBlobKey: nonEmptyStringSchema.optional()
      })
      .strict()
  ]);

const taskObjectSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    projectId: identifierSchema,
    type: taskTypeSchema,
    title: nonEmptyStringSchema.max(500),
    objective: nonEmptyStringSchema,
    constraints: z.array(nonEmptyStringSchema),
    acceptanceCriteria: z.array(nonEmptyStringSchema),
    status: taskStatusSchema,
    latestRunId: identifierSchema.optional(),
    createdBy: identifierSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.optional(),
    cancelledAt: isoDateTimeSchema.optional(),
    archivedAt: isoDateTimeSchema.optional()
  })
  .strict();

export const taskSchema = taskObjectSchema.superRefine((task, context) => {
  const requiredTimestamp =
    task.status === 'completed'
      ? 'completedAt'
      : task.status === 'cancelled'
        ? 'cancelledAt'
        : task.status === 'archived'
          ? 'archivedAt'
          : undefined;
  if (requiredTimestamp !== undefined && task[requiredTimestamp] === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [requiredTimestamp],
      message: `${task.status} Task requires ${requiredTimestamp}`
    });
  }
  if (
    task.status === 'open' &&
    (task.completedAt !== undefined ||
      task.cancelledAt !== undefined ||
      task.archivedAt !== undefined)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'Open Task cannot carry terminal timestamps'
    });
  }
});

export const createTaskInputSchema = taskObjectSchema
  .pick({ projectId: true, type: true, title: true, objective: true, constraints: true, acceptanceCriteria: true })
  .extend({ sourceIds: z.array(identifierSchema).default([]) })
  .strict();

export const taskMessageContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: nonEmptyStringSchema }).strict(),
  z
    .object({
      type: z.literal('source_reference'),
      sourceId: identifierSchema,
      label: z.string().optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('artifact_reference'),
      artifactId: identifierSchema,
      label: z.string().optional()
    })
    .strict()
]);

export const taskMessageSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    projectId: identifierSchema,
    taskId: identifierSchema,
    runId: identifierSchema.optional(),
    role: taskMessageRoleSchema,
    content: z.array(taskMessageContentBlockSchema).min(1),
    createdBy: identifierSchema.optional(),
    createdAt: isoDateTimeSchema
  })
  .strict();

export const appendTaskMessageInputSchema = taskMessageSchema
  .pick({ taskId: true, runId: true, role: true, content: true })
  .strict();

export const modelSnapshotSchema = z
  .object({
    requestedModelProfileId: identifierSchema.optional(),
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
    configuration: z.record(jsonValueSchema).optional()
  })
  .strict();

export const runResourceLimitsSchema = z
  .object({
    cpuMillis: z.number().int().positive(),
    memoryBytes: z.number().int().positive(),
    maxPids: z.number().int().positive(),
    diskBytes: z.number().int().positive(),
    maxDurationMs: z.number().int().positive(),
    maxSourceBytes: z.number().int().nonnegative(),
    maxArtifactBytes: z.number().int().nonnegative(),
    maxEventPayloadBytes: z.number().int().positive(),
    maxTokens: z.number().int().positive().optional(),
    maxCostUsd: z.number().nonnegative().optional()
  })
  .strict();

export const runUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative()
  })
  .strict();

export const runSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    projectId: identifierSchema,
    taskId: identifierSchema,
    attempt: z.number().int().positive(),
    status: runStatusSchema,
    mode: z.enum(['auto', 'plan']),
    model: modelSnapshotSchema,
    executionProfile: z.literal('work'),
    permissionPolicy: permissionPolicySnapshotSchema,
    resourceLimits: runResourceLimitsSchema,
    selectedSourceIds: z.array(identifierSchema),
    queuedAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.optional(),
    finishedAt: isoDateTimeSchema.optional(),
    failureCode: nonEmptyStringSchema.optional(),
    failureSummary: z.string().max(10_000).optional(),
    usage: runUsageSchema,
    checkpointKey: nonEmptyStringSchema.optional(),
    executionWorkspaceId: identifierSchema.optional(),
    createdBy: identifierSchema,
    createdAt: isoDateTimeSchema
  })
  .strict()
  .superRefine((run, context) => {
    const active = [
      'queued',
      'provisioning',
      'running',
      'waiting_for_approval',
      'cancelling'
    ].includes(run.status);
    const terminal = ['completed', 'failed', 'cancelled'].includes(run.status);

    if (active && run.finishedAt !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['finishedAt'],
        message: 'Active Run cannot have finishedAt'
      });
    }
    if (terminal && run.finishedAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['finishedAt'],
        message: 'Terminal Run requires finishedAt'
      });
    }
    if (
      ['running', 'waiting_for_approval', 'completed'].includes(run.status) &&
      run.startedAt === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startedAt'],
        message: `${run.status} Run requires startedAt`
      });
    }
    if (run.status === 'failed' && run.failureCode === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCode'],
        message: 'Failed Run requires failureCode'
      });
    }
    if (
      (run.status === 'queued' || run.status === 'provisioning') &&
      run.startedAt !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startedAt'],
        message: `${run.status} Run cannot have startedAt`
      });
    }
    if (run.status !== 'failed' && (run.failureCode !== undefined || run.failureSummary !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCode'],
        message: 'Only a failed Run can carry failure details'
      });
    }
    if (
      run.startedAt !== undefined &&
      Date.parse(run.startedAt) < Date.parse(run.queuedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['startedAt'],
        message: 'Run startedAt cannot precede queuedAt'
      });
    }
    if (
      run.finishedAt !== undefined &&
      Date.parse(run.finishedAt) < Date.parse(run.startedAt ?? run.queuedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['finishedAt'],
        message: 'Run finishedAt cannot precede its start'
      });
    }
  });

export const createRunInputSchema = z
  .object({
    taskId: identifierSchema,
    requestedModelProfileId: identifierSchema.optional(),
    selectedSourceIds: z.array(identifierSchema),
    mode: z.enum(['auto', 'plan']),
    idempotencyKey: nonEmptyStringSchema.max(500)
  })
  .strict();

export const runEventSchema = z
  .object({
    eventId: identifierSchema,
    organizationId: identifierSchema,
    projectId: identifierSchema,
    taskId: identifierSchema,
    runId: identifierSchema,
    workerGeneration: z.number().int().positive(),
    seq: z.number().int().positive(),
    type: nonEmptyStringSchema.max(200),
    timestamp: isoDateTimeSchema,
    payload: z.record(jsonValueSchema)
  })
  .strict();

export const appendRunEventInputSchema = runEventSchema
  .pick({ runId: true, workerGeneration: true, seq: true, type: true, timestamp: true, payload: true })
  .strict();

export const approvalTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('plan'), planDigest: nonEmptyStringSchema }).strict(),
  z
    .object({
      type: z.literal('tool'),
      toolCallId: identifierSchema,
      toolName: nonEmptyStringSchema,
      argumentsHash: sha256Schema
    })
    .strict(),
  z
    .object({
      type: z.literal('external_action'),
      actionType: nonEmptyStringSchema,
      idempotencyKey: nonEmptyStringSchema,
      argumentsHash: sha256Schema
    })
    .strict(),
  z
    .object({
      type: z.literal('elevated_access'),
      capability: nonEmptyStringSchema,
      argumentsHash: sha256Schema.optional()
    })
    .strict()
]);

const approvalObjectSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    projectId: identifierSchema,
    taskId: identifierSchema,
    runId: identifierSchema,
    kind: approvalKindSchema,
    scope: z.enum(['run', 'organization']),
    status: approvalStatusSchema,
    riskLevel: riskLevelSchema,
    actionPreview: nonEmptyStringSchema.max(20_000),
    target: approvalTargetSchema,
    requestHash: sha256Schema,
    requestedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema.optional(),
    decidedBy: identifierSchema.optional(),
    decisionReason: z.string().max(5_000).optional(),
    decidedAt: isoDateTimeSchema.optional(),
    decisionIdempotencyKey: nonEmptyStringSchema.optional(),
    consumedAt: isoDateTimeSchema.optional(),
    consumptionIdempotencyKey: nonEmptyStringSchema.optional()
  })
  .strict();

function validateApproval(
  approval: {
    kind: (typeof approvalKinds)[number];
    status?: (typeof approvalStatuses)[number];
    requestHash: string;
    target: z.infer<typeof approvalTargetSchema>;
    decidedBy?: string;
    decidedAt?: string;
    decisionIdempotencyKey?: string;
    consumedAt?: string;
    consumptionIdempotencyKey?: string;
    requestedAt?: string;
    expiresAt?: string;
    decisionReason?: string;
  },
  context: z.RefinementCtx
): void {
  if (approval.kind !== approval.target.type) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['target', 'type'],
      message: `Approval kind ${approval.kind} requires a matching target type`
    });
  }
  if (
    'argumentsHash' in approval.target &&
    approval.target.argumentsHash !== undefined &&
    approval.target.argumentsHash !== approval.requestHash
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requestHash'],
      message: 'Approval requestHash must match the target argumentsHash'
    });
  }
  if (approval.status !== undefined) {
    const hasCompleteDecision =
      approval.decidedBy !== undefined &&
      approval.decidedAt !== undefined &&
      approval.decisionIdempotencyKey !== undefined;
    const isExplicitDecision =
      approval.status === 'approved' || approval.status === 'rejected';
    if (isExplicitDecision !== hasCompleteDecision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'Approved/rejected Approval must exclusively carry complete decision fields'
      });
    }
    if (!isExplicitDecision && approval.decisionReason !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisionReason'],
        message: 'Only approved/rejected Approval may carry a decision reason'
      });
    }
    const hasConsumedAt = approval.consumedAt !== undefined;
    const hasConsumptionKey = approval.consumptionIdempotencyKey !== undefined;
    if (hasConsumedAt !== hasConsumptionKey || (hasConsumedAt && approval.status !== 'approved')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['consumedAt'],
        message: 'Consumption fields must be paired and may only exist on approved Approval'
      });
    }
    if (
      approval.requestedAt !== undefined &&
      approval.expiresAt !== undefined &&
      Date.parse(approval.expiresAt) <= Date.parse(approval.requestedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expiresAt'],
        message: 'Approval expiresAt must follow requestedAt'
      });
    }
    if (
      approval.requestedAt !== undefined &&
      approval.decidedAt !== undefined &&
      Date.parse(approval.decidedAt) < Date.parse(approval.requestedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decidedAt'],
        message: 'Approval decidedAt cannot precede requestedAt'
      });
    }
    if (
      approval.consumedAt !== undefined &&
      approval.decidedAt !== undefined &&
      Date.parse(approval.consumedAt) < Date.parse(approval.decidedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['consumedAt'],
        message: 'Approval consumedAt cannot precede decidedAt'
      });
    }
  }
}

export const approvalSchema = approvalObjectSchema.superRefine(validateApproval);

export const requestApprovalInputSchema = approvalObjectSchema
  .pick({
    runId: true,
    kind: true,
    scope: true,
    riskLevel: true,
    actionPreview: true,
    target: true,
    requestHash: true,
    expiresAt: true
  })
  .strict()
  .superRefine(validateApproval);

export const decideApprovalInputSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().max(5_000).optional(),
    idempotencyKey: nonEmptyStringSchema.max(500)
  })
  .strict();

const artifactObjectSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    projectId: identifierSchema,
    taskId: identifierSchema,
    runId: identifierSchema,
    kind: artifactKindSchema,
    status: artifactStatusSchema,
    displayName: nonEmptyStringSchema.max(500),
    mimeType: nonEmptyStringSchema.optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    sha256: sha256Schema.optional(),
    blobKey: nonEmptyStringSchema.optional(),
    parentArtifactId: identifierSchema.optional(),
    previewBlobKey: nonEmptyStringSchema.optional(),
    thumbnailBlobKey: nonEmptyStringSchema.optional(),
    sourceIds: z.array(identifierSchema),
    diagnosticsBlobKey: nonEmptyStringSchema.optional(),
    createdAt: isoDateTimeSchema
  })
  .strict();

export const artifactSchema = artifactObjectSchema.superRefine((artifact, context) => {
    if (
      artifact.status === 'ready' &&
      (artifact.mimeType === undefined ||
        artifact.sizeBytes === undefined ||
        artifact.sha256 === undefined ||
        artifact.blobKey === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'Ready Artifact requires MIME, size, sha256, and blobKey'
      });
    }
});

export const reserveArtifactInputSchema = artifactObjectSchema
  .pick({ runId: true, kind: true, displayName: true, mimeType: true, parentArtifactId: true, sourceIds: true })
  .strict();

export const commitArtifactInputSchema = artifactObjectSchema
  .pick({ sizeBytes: true, sha256: true, blobKey: true, previewBlobKey: true, thumbnailBlobKey: true, diagnosticsBlobKey: true })
  .required({ sizeBytes: true, sha256: true, blobKey: true })
  .strict();

export const connectorCapabilitySnapshotSchema = z
  .object({
    toolNames: z.array(nonEmptyStringSchema),
    resourceTypes: z.array(nonEmptyStringSchema),
    capturedAt: isoDateTimeSchema
  })
  .strict();

const connectorInstallationBaseSchema = z.object({
  id: identifierSchema,
  organizationId: identifierSchema,
  connectorDefinitionId: identifierSchema,
  status: connectorInstallationStatusSchema,
  authorizedBy: identifierSchema,
  scopes: z.array(nonEmptyStringSchema),
  encryptedCredentialRef: identifierSchema.optional(),
  capabilities: connectorCapabilitySnapshotSchema.optional(),
  lastCheckedAt: isoDateTimeSchema.optional(),
  errorCategory: nonEmptyStringSchema.optional(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema
});

export const connectorInstallationSchema = z.discriminatedUnion('scope', [
  connectorInstallationBaseSchema.extend({ scope: z.literal('organization') }).strict(),
  connectorInstallationBaseSchema
    .extend({ scope: z.literal('project'), projectId: identifierSchema })
    .strict()
]);

export const installConnectorInputSchema = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('organization'),
      connectorDefinitionId: identifierSchema,
      scopes: z.array(nonEmptyStringSchema)
    })
    .strict(),
  z
    .object({
      scope: z.literal('project'),
      projectId: identifierSchema,
      connectorDefinitionId: identifierSchema,
      scopes: z.array(nonEmptyStringSchema)
    })
    .strict()
]);

export const scheduleTriggerSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('cron'),
      expression: nonEmptyStringSchema,
      timezone: nonEmptyStringSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('interval'),
      intervalSeconds: z.number().int().positive(),
      timezone: nonEmptyStringSchema
    })
    .strict()
]);

export const scheduleTaskTemplateSchema = z
  .object({
    type: taskTypeSchema,
    title: nonEmptyStringSchema.max(500),
    objective: nonEmptyStringSchema,
    constraints: z.array(nonEmptyStringSchema),
    acceptanceCriteria: z.array(nonEmptyStringSchema)
  })
  .strict();

export const scheduleSchema = z
  .object({
    id: identifierSchema,
    organizationId: identifierSchema,
    projectId: identifierSchema,
    name: nonEmptyStringSchema.max(200),
    status: scheduleStatusSchema,
    taskTemplate: scheduleTaskTemplateSchema,
    sourceIds: z.array(identifierSchema),
    connectorInstallationIds: z.array(identifierSchema),
    trigger: scheduleTriggerSchema,
    nextRunAt: isoDateTimeSchema.optional(),
    concurrencyPolicy: scheduleConcurrencyPolicySchema,
    externalActionPolicy: externalActionPolicySchema,
    createdBy: identifierSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema
  })
  .strict();

export const createScheduleInputSchema = scheduleSchema
  .pick({
    projectId: true,
    name: true,
    taskTemplate: true,
    sourceIds: true,
    connectorInstallationIds: true,
    trigger: true,
    concurrencyPolicy: true
  })
  .extend({ externalActionPolicy: externalActionPolicySchema.default('draft_only') })
  .strict();

export const updateScheduleInputSchema = z
  .object({
    name: nonEmptyStringSchema.max(200).optional(),
    taskTemplate: scheduleTaskTemplateSchema.optional(),
    sourceIds: z.array(identifierSchema).optional(),
    connectorInstallationIds: z.array(identifierSchema).optional(),
    trigger: scheduleTriggerSchema.optional(),
    concurrencyPolicy: scheduleConcurrencyPolicySchema.optional(),
    externalActionPolicy: externalActionPolicySchema.optional()
  })
  .strict();
