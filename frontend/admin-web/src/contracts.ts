import { z } from 'zod';

const id = z.string().min(1);
const date = z.string().datetime({ offset: true });

export const membershipSchema = z
  .object({
    id,
    organizationId: id,
    organizationName: z.string().min(1),
    organizationSlug: z.string().min(1),
    userId: id,
    role: z.enum(['admin', 'member']),
    status: z.enum(['active', 'invited', 'disabled']),
    createdAt: date,
    updatedAt: date
  })
  .strict();

export const genderSchema = z.enum(['unspecified', 'male', 'female', 'other']);

export const userProfileSchema = z
  .object({
    userId: id,
    username: z.string().min(1),
    displayName: z.string().min(1),
    platformRole: z.enum(['super_admin', 'user']),
    status: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    avatarUrl: z.string().min(1).optional(),
    gender: genderSchema.optional(),
    phone: z.string().min(1).optional()
  })
  .strict();

export const sessionSchema = z
  .object({
    user: userProfileSchema,
    memberships: z.array(membershipSchema),
    canAccessAdmin: z.boolean()
  })
  .strict();

export const authConfigSchema = z
  .object({
    registrationEnabled: z.boolean(),
    bootstrapRequired: z.boolean(),
    organizationExists: z.boolean(),
    ssoEnabled: z.boolean(),
    ssoDisplayName: z.string().min(1).optional()
  })
  .strict();

export const platformSchema = z
  .object({
    registrationEnabled: z.boolean()
  })
  .strict();

export const platformSsoSchema = z
  .object({
    enabled: z.boolean(),
    displayName: z.string().min(1).optional(),
    issuer: z.string().min(1).optional(),
    clientId: z.string().min(1).optional(),
    clientSecretConfigured: z.boolean(),
    redirectUri: z.string().min(1),
    additionalRedirectUris: z.array(z.string().min(1))
  })
  .strict();

export const platformOrganizationSchema = z
  .object({
    id,
    slug: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(['active', 'suspended', 'deleted']),
    adminCount: z.number().int().nonnegative(),
    memberCount: z.number().int().nonnegative(),
    createdAt: date
  })
  .strict();

export const userAccountSchema = z
  .object({
    userId: id,
    username: z.string().min(1),
    displayName: z.string().min(1),
    avatarUrl: z.string().min(1).optional(),
    platformRole: z.enum(['super_admin', 'user']),
    status: z.string().min(1),
    createdAt: date
  })
  .strict();

export const usageSchema = z
  .object({
    messages1d: z.number().int().nonnegative(),
    messages7d: z.number().int().nonnegative()
  })
  .strict();

export const agentRuntimeSchema = z
  .object({
    id,
    userId: id,
    username: z.string().min(1),
    displayName: z.string().min(1),
    status: z.string().min(1),
    nodeId: z.string().min(1).nullish(),
    lastError: z.string().nullish(),
    lastActiveAt: date.nullish(),
    connected: z.boolean()
  })
  .strict();

export const nodeHealthSchema = z
  .object({
    id,
    hostname: z.string().nullish(),
    status: z.string().min(1),
    runningAgents: z.number().int().nonnegative(),
    juicefsOk: z.boolean(),
    lastSeenAt: date.nullish(),
    connected: z.boolean()
  })
  .strict();

export const dashboardSchema = z
  .object({
    counts: z
      .object({
        activeMembers: z.number().int().nonnegative(),
        runningAgents: z.number().int().nonnegative(),
        stoppedAgents: z.number().int().nonnegative()
      })
      .strict(),
    usage: usageSchema,
    agents: z.array(agentRuntimeSchema),
    nodes: z.array(nodeHealthSchema)
  })
  .strict();

export const inviteSchema = z
  .object({
    id,
    role: z.enum(['admin', 'member']),
    expiresAt: date,
    acceptedAt: date.nullish(),
    createdAt: date
  })
  .strict();

export const createdInviteSchema = z
  .object({
    id,
    token: z.string().min(1),
    role: z.enum(['admin', 'member']),
    expiresAt: date,
    path: z.string().min(1)
  })
  .strict();

export const memberSchema = z
  .object({
    id,
    userId: id,
    username: z.string().min(1),
    displayName: z.string().min(1),
    avatarUrl: z.string().min(1).optional(),
    role: z.enum(['admin', 'member']),
    status: z.enum(['active', 'invited', 'disabled']),
    createdAt: date,
    updatedAt: date
  })
  .strict();

export const modelSchema = z
  .object({
    id,
    name: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    contextWindow: z.number().int().positive(),
    credentialHandleId: id.nullable(),
    configuration: z.record(z.unknown()),
    status: z.enum(['active', 'disabled']),
    createdAt: date,
    updatedAt: date
  })
  .strict();

export const platformSkillSchema = z
  .object({
    id,
    name: z.string().min(1),
    description: z.string(),
    category: z.string().min(1),
    icon: z.string().min(1),
    launchMode: z.enum(['instant', 'form', 'file']),
    starterPrompt: z.string(),
    revision: z.number().int().nonnegative(),
    latestVersion: z.number().int().nonnegative(),
    versionCount: z.number().int().nonnegative(),
    packageSha256: z.string().length(64).nullish(),
    packageSizeBytes: z.number().int().nonnegative(),
    status: z.enum(['draft', 'active', 'disabled']),
    installCount: z.number().int().nonnegative(),
    createdAt: date,
    updatedAt: date
  })
  .strict();

export const organizationSkillSchema = z
  .object({
    id,
    name: z.string().min(1),
    description: z.string(),
    category: z.string().min(1),
    icon: z.string().min(1),
    launchMode: z.enum(['instant', 'form', 'file']),
    starterPrompt: z.string(),
    revision: z.number().int().positive(),
    status: z.enum(['active', 'disabled']),
    installed: z.boolean(),
    installedAt: date.nullish()
  })
  .strict();

export const skillVersionSchema = z
  .object({
    version: z.number().int().positive(),
    packageSha256: z.string().length(64).nullish(),
    packageSizeBytes: z.number().int().nonnegative(),
    manifest: z.record(z.unknown()),
    changelog: z.string(),
    active: z.boolean(),
    createdAt: date,
    publishedAt: date.nullish()
  })
  .strict();

export const skillPackageDownloadSchema = z
  .object({ url: z.string().url(), expiresAt: date })
  .strict();

const tokenUsageTrendSchema = z
  .object({
    date: z.string().min(1),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    llmCalls: z.number().nonnegative()
  })
  .strict();

const tokenUsageRankSchema = z
  .object({
    id,
    name: z.string().min(1),
    secondary: z.string(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    llmCalls: z.number().nonnegative()
  })
  .strict();

export const tokenUsageSchema = z
  .object({
    scope: z.enum(['platform', 'organization']),
    organizationId: id.nullable(),
    days: z.number().int().positive(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    cacheWriteTokens: z.number().nonnegative(),
    reasoningTokens: z.number().nonnegative(),
    llmCalls: z.number().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
    trend: z.array(tokenUsageTrendSchema),
    organizations: z.array(tokenUsageRankSchema),
    users: z.array(tokenUsageRankSchema),
    models: z.array(tokenUsageRankSchema)
  })
  .strict();

export const approvalPolicySchema = z
  .object({
    defaultTimezone: z.string().min(1),
    dataRetentionDays: z.number().int().positive().nullable(),
    approvalPolicy: z
      .object({
        requirePlanApproval: z.boolean(),
        requireExternalActionApproval: z.boolean(),
        minimumToolRiskRequiringApproval: z.enum(['low', 'medium', 'high', 'critical']),
        allowAdminOrganizationHighRiskApproval: z.boolean(),
        allowMemberHighRiskApproval: z.boolean()
      })
      .strict()
  })
  .strict();

export const auditLogSchema = z
  .object({
    id,
    actorUserId: id.nullable(),
    action: z.string().min(1),
    resourceType: z.string().min(1),
    resourceId: id.nullable(),
    payload: z.record(z.unknown()),
    occurredAt: date
  })
  .strict();

export const authLoginEventSchema = z
  .object({
    id,
    eventType: z.enum(['login', 'logout']),
    method: z.enum(['password', 'sso', 'session']),
    outcome: z.enum(['success', 'failure']),
    username: z.string().min(1).nullish(),
    userId: z.string().min(1).nullish(),
    reason: z.string().min(1).nullish(),
    ip: z.string().min(1).nullish(),
    userAgent: z.string().min(1).nullish(),
    occurredAt: date
  })
  .strict();

export const page = <T extends z.ZodTypeAny>(item: T) =>
  z
    .object({
      items: z.array(item),
      page: z.number().int().positive(),
      pageSize: z.number().int().positive(),
      total: z.number().int().nonnegative()
    })
    .strict();

export type Session = z.infer<typeof sessionSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type PlatformSettings = z.infer<typeof platformSchema>;
export type PlatformSso = z.infer<typeof platformSsoSchema>;
export type PlatformOrganization = z.infer<typeof platformOrganizationSchema>;
export type UserAccount = z.infer<typeof userAccountSchema>;
export type Dashboard = z.infer<typeof dashboardSchema>;
export type AgentRuntime = z.infer<typeof agentRuntimeSchema>;
export type NodeHealth = z.infer<typeof nodeHealthSchema>;
export type Invite = z.infer<typeof inviteSchema>;
export type CreatedInvite = z.infer<typeof createdInviteSchema>;
export type Member = z.infer<typeof memberSchema>;
export type PlatformSkill = z.infer<typeof platformSkillSchema>;
export type OrganizationSkill = z.infer<typeof organizationSkillSchema>;
export type SkillVersion = z.infer<typeof skillVersionSchema>;
export type ModelConfig = z.infer<typeof modelSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type TokenUsageRank = z.infer<typeof tokenUsageRankSchema>;
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;
export type AuditLog = z.infer<typeof auditLogSchema>;
export type AuthLoginEvent = z.infer<typeof authLoginEventSchema>;
