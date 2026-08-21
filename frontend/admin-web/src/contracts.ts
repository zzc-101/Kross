import { z } from 'zod';

const id = z.string().min(1);
const date = z.string().datetime({ offset: true });

export const membershipSchema = z.object({
  id, organizationId: id, organizationName: z.string().min(1), organizationSlug: z.string().min(1),
  userId: id,
  role: z.enum(['admin', 'member']),
  status: z.enum(['active', 'invited', 'disabled']), createdAt: date, updatedAt: date
}).strict();

export const genderSchema = z.enum(['unspecified', 'male', 'female', 'other']);

export const userProfileSchema = z.object({
  userId: id,
  username: z.string().min(1),
  displayName: z.string().min(1),
  platformRole: z.enum(['super_admin', 'user']),
  status: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  avatarUrl: z.string().min(1).optional(),
  gender: genderSchema.optional(),
  phone: z.string().min(1).optional()
}).strict();

export const sessionSchema = z.object({
  user: userProfileSchema,
  memberships: z.array(membershipSchema),
  canAccessAdmin: z.boolean()
}).strict();

export const authConfigSchema = z.object({
  registrationEnabled: z.boolean(),
  bootstrapRequired: z.boolean(),
  organizationExists: z.boolean(),
  ssoEnabled: z.boolean(),
  ssoDisplayName: z.string().min(1).optional()
}).strict();

export const platformSchema = z.object({
  registrationEnabled: z.boolean()
}).strict();

export const platformSsoSchema = z.object({
  enabled: z.boolean(),
  displayName: z.string().min(1).optional(),
  issuer: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  clientSecretConfigured: z.boolean(),
  redirectUri: z.string().min(1),
  additionalRedirectUris: z.array(z.string().min(1))
}).strict();

export const platformOrganizationSchema = z.object({
  id, slug: z.string().min(1), name: z.string().min(1),
  status: z.enum(['active', 'suspended', 'deleted']),
  adminCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  createdAt: date
}).strict();

export const userAccountSchema = z.object({
  userId: id,
  username: z.string().min(1),
  displayName: z.string().min(1),
  avatarUrl: z.string().min(1).optional(),
  platformRole: z.enum(['super_admin', 'user']),
  status: z.string().min(1),
  createdAt: date
}).strict();

export const dashboardSchema = z.object({ counts: z.object({
  activeMembers: z.number().int().nonnegative(),
  runningAgents: z.number().int().nonnegative(),
  stoppedAgents: z.number().int().nonnegative()
}).strict() }).strict();

export const memberSchema = z.object({
  id, userId: id, username: z.string().min(1), displayName: z.string().min(1),
  avatarUrl: z.string().min(1).optional(),
  role: z.enum(['admin', 'member']),
  status: z.enum(['active', 'invited', 'disabled']), createdAt: date, updatedAt: date
}).strict();

export const modelSchema = z.object({
  id, name: z.string().min(1), provider: z.string().min(1), model: z.string().min(1),
  credentialHandleId: id.nullable(), configuration: z.record(z.unknown()),
  status: z.enum(['active', 'disabled']), createdAt: date, updatedAt: date
}).strict();

export const approvalPolicySchema = z.object({
  defaultTimezone: z.string().min(1), dataRetentionDays: z.number().int().positive().nullable(),
  approvalPolicy: z.object({
    requirePlanApproval: z.boolean(), requireExternalActionApproval: z.boolean(),
    minimumToolRiskRequiringApproval: z.enum(['low', 'medium', 'high', 'critical']),
    allowAdminOrganizationHighRiskApproval: z.boolean(), allowMemberHighRiskApproval: z.boolean()
  }).strict()
}).strict();

export const auditLogSchema = z.object({
  id, actorUserId: id.nullable(), action: z.string().min(1),
  resourceType: z.string().min(1), resourceId: id.nullable(),
  payload: z.record(z.unknown()), occurredAt: date
}).strict();

export const page = <T extends z.ZodTypeAny>(item: T) => z.object({
  items: z.array(item), page: z.number().int().positive(), pageSize: z.number().int().positive(), total: z.number().int().nonnegative()
}).strict();

export type Session = z.infer<typeof sessionSchema>;
export type UserProfile = z.infer<typeof userProfileSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type PlatformSettings = z.infer<typeof platformSchema>;
export type PlatformSso = z.infer<typeof platformSsoSchema>;
export type PlatformOrganization = z.infer<typeof platformOrganizationSchema>;
export type UserAccount = z.infer<typeof userAccountSchema>;
export type Dashboard = z.infer<typeof dashboardSchema>;
export type Member = z.infer<typeof memberSchema>;
export type ModelConfig = z.infer<typeof modelSchema>;
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;
export type AuditLog = z.infer<typeof auditLogSchema>;
