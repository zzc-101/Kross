import { z } from 'zod';

const id = z.string().min(1);
const date = z.string().datetime({ offset: true });

export const membershipSchema = z.object({
  id, organizationId: id, userId: id,
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
  status: z.enum(['active', 'invited', 'disabled']), createdAt: date, updatedAt: date
}).strict();

export const bootstrapSchema = z.object({
  user: z.object({ userId: id, displayName: z.string().min(1) }).strict(),
  memberships: z.array(membershipSchema)
}).strict();

export const dashboardSchema = z.object({ counts: z.object({
  activeMembers: z.number().int().nonnegative(), activeProjects: z.number().int().nonnegative(),
  activeRuns: z.number().int().nonnegative(), pendingApprovals: z.number().int().nonnegative(),
  activeConnectors: z.number().int().nonnegative()
}).strict() }).strict();

export const memberSchema = z.object({
  id, userId: id, displayName: z.string().min(1),
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
  status: z.enum(['active', 'invited', 'disabled']), createdAt: date, updatedAt: date
}).strict();

export const modelSchema = z.object({
  id, name: z.string().min(1), provider: z.string().min(1), model: z.string().min(1),
  credentialHandleId: id.nullable(), configuration: z.record(z.unknown()),
  status: z.enum(['active', 'disabled']), createdAt: date, updatedAt: date
}).strict();

export const connectorSchema = z.object({
  id, organization_id: id, project_id: id.nullable(), connector_definition_id: id,
  display_name: z.string().min(1), granted_scopes: z.array(z.string()),
  status: z.enum(['available', 'unavailable']), last_error_code: z.string().nullable(),
  created_at: date, updated_at: date, connector_name: z.string().min(1),
  allowed_tools: z.array(z.string()), required_scopes: z.array(z.string())
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
export const connectorPageSchema = z.object({ items: z.array(connectorSchema) }).strict();
export const bootstrapResultSchema = z.object({
  organization: z.object({ id, slug: z.string().min(2), name: z.string().min(1), defaultTimezone: z.string().min(1) }).strict(),
  membership: z.object({ id, userId: id, role: z.literal('owner'), status: z.literal('active') }).strict()
}).strict();

export type Bootstrap = z.infer<typeof bootstrapSchema>;
export type Dashboard = z.infer<typeof dashboardSchema>;
export type Member = z.infer<typeof memberSchema>;
export type ModelConfig = z.infer<typeof modelSchema>;
export type Connector = z.infer<typeof connectorSchema>;
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;
export type AuditLog = z.infer<typeof auditLogSchema>;
