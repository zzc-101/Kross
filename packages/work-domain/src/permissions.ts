import { DomainInvariantError } from './errors';
import type { Approval, ApprovalPolicy, Membership, MembershipRole } from './types';

export const organizationActions = [
  'organization.read',
  'organization.update',
  'organization.delete',
  'membership.read',
  'membership.invite',
  'membership.update',
  'membership.remove',
  'credential.manage',
  'model_profile.manage',
  'connector.manage',
  'project.read',
  'project.create',
  'project.update',
  'project.delete',
  'source.read',
  'source.create',
  'source.delete',
  'task.read',
  'task.create',
  'task.update',
  'task.cancel',
  'task.archive',
  'run.read',
  'run.create',
  'run.cancel',
  'approval.read',
  'approval.decide',
  'artifact.read',
  'artifact.delete',
  'schedule.read',
  'schedule.manage',
  'audit.read'
] as const;

export type OrganizationAction = (typeof organizationActions)[number];

const viewerActions = [
  'organization.read',
  'membership.read',
  'project.read',
  'source.read',
  'task.read',
  'run.read',
  'approval.read',
  'artifact.read',
  'schedule.read'
] as const satisfies readonly OrganizationAction[];

const memberActions = [
  ...viewerActions,
  'project.create',
  'source.create',
  'task.create',
  'run.create',
  'approval.decide'
] as const satisfies readonly OrganizationAction[];

const adminActions = [
  ...memberActions,
  'membership.invite',
  'membership.update',
  'membership.remove',
  'credential.manage',
  'model_profile.manage',
  'connector.manage',
  'project.update',
  'project.delete',
  'source.delete',
  'task.update',
  'task.cancel',
  'task.archive',
  'run.cancel',
  'artifact.delete',
  'schedule.manage',
  'audit.read'
] as const satisfies readonly OrganizationAction[];

const roleActions: Readonly<Record<MembershipRole, ReadonlySet<OrganizationAction>>> = {
  owner: new Set(organizationActions),
  admin: new Set(adminActions),
  member: new Set(memberActions),
  viewer: new Set(viewerActions)
};

export function hasRolePermission(role: MembershipRole, action: OrganizationAction): boolean {
  return roleActions[role].has(action);
}

export function canMembershipPerform(
  membership: Pick<Membership, 'status' | 'role'>,
  action: OrganizationAction
): boolean {
  return membership.status === 'active' && hasRolePermission(membership.role, action);
}

export function assertMembershipCanPerform(
  membership: Pick<Membership, 'id' | 'status' | 'role'>,
  action: OrganizationAction
): void {
  if (!canMembershipPerform(membership, action)) {
    throw new DomainInvariantError(
      'permission_denied',
      `Membership ${membership.id} cannot perform ${action}`,
      { membershipId: membership.id, role: membership.role, status: membership.status, action }
    );
  }
}

type MembershipActor = Pick<Membership, 'organizationId' | 'role' | 'status'>;
type MembershipTarget = Pick<Membership, 'organizationId' | 'role'>;

export interface InviteMembershipPermissionContext {
  actor: MembershipActor;
  targetOrganizationId: string;
  invitedRole: MembershipRole;
}

export interface UpdateMembershipPermissionContext {
  actor: MembershipActor;
  target: MembershipTarget;
  nextRole: MembershipRole;
}

export interface RemoveMembershipPermissionContext {
  actor: MembershipActor;
  target: MembershipTarget;
}

function canManageRole(actor: MembershipActor, role: MembershipRole): boolean {
  if (actor.status !== 'active') {
    return false;
  }
  if (actor.role === 'owner') {
    return true;
  }
  return actor.role === 'admin' && (role === 'member' || role === 'viewer');
}

export function canInviteMembership(context: InviteMembershipPermissionContext): boolean {
  return (
    context.actor.organizationId === context.targetOrganizationId &&
    hasRolePermission(context.actor.role, 'membership.invite') &&
    canManageRole(context.actor, context.invitedRole)
  );
}

export function canUpdateMembership(context: UpdateMembershipPermissionContext): boolean {
  return (
    context.actor.organizationId === context.target.organizationId &&
    hasRolePermission(context.actor.role, 'membership.update') &&
    canManageRole(context.actor, context.target.role) &&
    canManageRole(context.actor, context.nextRole)
  );
}

/**
 * This role check cannot safely protect the last owner. Removing or demoting an owner must also
 * lock/count active owners in the same database transaction and reject removal of the last one.
 */
export function canRemoveMembership(context: RemoveMembershipPermissionContext): boolean {
  return (
    context.actor.organizationId === context.target.organizationId &&
    hasRolePermission(context.actor.role, 'membership.remove') &&
    canManageRole(context.actor, context.target.role)
  );
}

export interface ApprovalPermissionContext {
  membership: Pick<Membership, 'status' | 'role'>;
  approval: Pick<Approval, 'scope' | 'riskLevel' | 'status'>;
  policy: Pick<
    ApprovalPolicy,
    'allowAdminOrganizationHighRiskApproval' | 'allowMemberHighRiskApproval'
  >;
  hasRunAccess: boolean;
}

export function canDecideApproval(context: ApprovalPermissionContext): boolean {
  const { approval, membership, policy } = context;
  if (
    membership.status !== 'active' ||
    approval.status !== 'pending' ||
    !context.hasRunAccess ||
    !hasRolePermission(membership.role, 'approval.decide')
  ) {
    return false;
  }

  const isHighRisk = approval.riskLevel === 'high' || approval.riskLevel === 'critical';
  if (!isHighRisk) {
    return true;
  }
  if (membership.role === 'owner') {
    return true;
  }
  if (membership.role === 'admin') {
    return approval.scope === 'run' || policy.allowAdminOrganizationHighRiskApproval;
  }
  if (membership.role === 'member') {
    return approval.scope === 'run' && policy.allowMemberHighRiskApproval;
  }
  return false;
}

export function assertCanDecideApproval(context: ApprovalPermissionContext): void {
  if (!canDecideApproval(context)) {
    throw new DomainInvariantError(
      'permission_denied',
      'Membership cannot decide this Approval',
      {
        role: context.membership.role,
        membershipStatus: context.membership.status,
        approvalStatus: context.approval.status,
        approvalScope: context.approval.scope,
        riskLevel: context.approval.riskLevel,
        hasRunAccess: context.hasRunAccess
      }
    );
  }
}
