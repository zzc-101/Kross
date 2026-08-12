import { describe, expect, it } from 'vitest';

import { DomainInvariantError } from './errors';
import {
  assertCanDecideApproval,
  assertMembershipCanPerform,
  canDecideApproval,
  canInviteMembership,
  canMembershipPerform,
  canRemoveMembership,
  canUpdateMembership,
  hasRolePermission
} from './permissions';
import { organizationActions } from './permissions';
import type { ApprovalPermissionContext, OrganizationAction } from './permissions';

const ordinaryApprovalContext: ApprovalPermissionContext = {
  membership: { role: 'member', status: 'active' },
  approval: { scope: 'run', riskLevel: 'medium', status: 'pending' },
  policy: {
    allowAdminOrganizationHighRiskApproval: false,
    allowMemberHighRiskApproval: false
  },
  hasRunAccess: true
};

describe('组织 RBAC', () => {
  const viewer = [
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
  const member = [
    ...viewer,
    'project.create',
    'source.create',
    'task.create',
    'run.create',
    'approval.decide'
  ] as const satisfies readonly OrganizationAction[];
  const admin = [
    ...member,
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
  const expected = {
    viewer: new Set<OrganizationAction>(viewer),
    member: new Set<OrganizationAction>(member),
    admin: new Set<OrganizationAction>(admin),
    owner: new Set<OrganizationAction>(organizationActions)
  } as const;

  it.each(['owner', 'admin', 'member', 'viewer'] as const)(
    '%s 的完整 action 矩阵严格匹配合同',
    (role) => {
      for (const action of organizationActions) {
        expect(hasRolePermission(role, action), `${role}: ${action}`).toBe(
          expected[role].has(action)
        );
      }
    }
  );

  it('member 不得更新、删除、取消或归档资源', () => {
    for (const action of [
      'project.update',
      'project.delete',
      'source.delete',
      'task.update',
      'task.cancel',
      'task.archive',
      'run.cancel',
      'artifact.delete'
    ] as const) {
      expect(hasRolePermission('member', action), action).toBe(false);
      expect(hasRolePermission('admin', action), action).toBe(true);
    }
  });

  it('拒绝 invited 或 disabled Membership，即使角色本身有权限', () => {
    const action: OrganizationAction = 'task.create';
    expect(canMembershipPerform({ role: 'owner', status: 'invited' }, action)).toBe(false);
    expect(canMembershipPerform({ role: 'owner', status: 'disabled' }, action)).toBe(false);
    expect(() =>
      assertMembershipCanPerform(
        { id: 'membership-1', role: 'owner', status: 'disabled' },
        action
      )
    ).toThrowError(
      expect.objectContaining<Partial<DomainInvariantError>>({ code: 'permission_denied' })
    );
  });

  it('成员 invite/update/remove 都要求 actor 与 target 组织一致', () => {
    const actor = {
      organizationId: 'org-1',
      role: 'owner' as const,
      status: 'active' as const
    };
    expect(
      canInviteMembership({ actor, targetOrganizationId: 'org-2', invitedRole: 'viewer' })
    ).toBe(false);
    expect(
      canUpdateMembership({
        actor,
        target: { organizationId: 'org-2', role: 'viewer' },
        nextRole: 'member'
      })
    ).toBe(false);
    expect(
      canRemoveMembership({
        actor,
        target: { organizationId: 'org-2', role: 'viewer' }
      })
    ).toBe(false);
  });

  it('admin 只能邀请、更新和移除 member/viewer', () => {
    const actor = {
      organizationId: 'org-1',
      role: 'admin' as const,
      status: 'active' as const
    };
    expect(
      canInviteMembership({ actor, targetOrganizationId: 'org-1', invitedRole: 'member' })
    ).toBe(true);
    expect(
      canInviteMembership({ actor, targetOrganizationId: 'org-1', invitedRole: 'admin' })
    ).toBe(false);
    expect(
      canUpdateMembership({
        actor,
        target: { organizationId: 'org-1', role: 'member' },
        nextRole: 'viewer'
      })
    ).toBe(true);
    expect(
      canUpdateMembership({
        actor,
        target: { organizationId: 'org-1', role: 'member' },
        nextRole: 'admin'
      })
    ).toBe(false);
    expect(
      canUpdateMembership({
        actor,
        target: { organizationId: 'org-1', role: 'admin' },
        nextRole: 'viewer'
      })
    ).toBe(false);
    expect(
      canRemoveMembership({
        actor,
        target: { organizationId: 'org-1', role: 'owner' }
      })
    ).toBe(false);
  });

  it('owner 可管理所有角色，但最后 owner 必须由数据库事务另行保护', () => {
    const actor = {
      organizationId: 'org-1',
      role: 'owner' as const,
      status: 'active' as const
    };
    expect(
      canUpdateMembership({
        actor,
        target: { organizationId: 'org-1', role: 'owner' },
        nextRole: 'viewer'
      })
    ).toBe(true);
    expect(
      canRemoveMembership({
        actor,
        target: { organizationId: 'org-1', role: 'owner' }
      })
    ).toBe(true);
  });
});

describe('Approval 权限', () => {
  it('允许 member 决定自己可访问 Run 的普通待决审批', () => {
    expect(canDecideApproval(ordinaryApprovalContext)).toBe(true);
    expect(() => assertCanDecideApproval(ordinaryApprovalContext)).not.toThrow();
  });

  it('无对应 Run 访问权时拒绝决定审批', () => {
    expect(
      canDecideApproval({ ...ordinaryApprovalContext, hasRunAccess: false })
    ).toBe(false);
  });

  it('默认拒绝 member 决定高风险审批，可由组织策略仅对 Run 级审批放开', () => {
    const highRisk = {
      ...ordinaryApprovalContext,
      approval: { ...ordinaryApprovalContext.approval, riskLevel: 'high' as const }
    };
    expect(canDecideApproval(highRisk)).toBe(false);
    expect(
      canDecideApproval({
        ...highRisk,
        policy: { ...highRisk.policy, allowMemberHighRiskApproval: true }
      })
    ).toBe(true);
    expect(
      canDecideApproval({
        ...highRisk,
        approval: { ...highRisk.approval, scope: 'organization' },
        policy: { ...highRisk.policy, allowMemberHighRiskApproval: true }
      })
    ).toBe(false);
  });

  it('admin 决定组织级高风险审批必须得到策略授权，owner 始终可以', () => {
    const adminContext: ApprovalPermissionContext = {
      ...ordinaryApprovalContext,
      membership: { role: 'admin', status: 'active' },
      approval: { scope: 'organization', riskLevel: 'critical', status: 'pending' }
    };
    expect(canDecideApproval(adminContext)).toBe(false);
    expect(
      canDecideApproval({
        ...adminContext,
        policy: { ...adminContext.policy, allowAdminOrganizationHighRiskApproval: true }
      })
    ).toBe(true);
    expect(
      canDecideApproval({
        ...adminContext,
        membership: { role: 'owner', status: 'active' }
      })
    ).toBe(true);
  });

  it('终态 Approval 不能再次被授权决定', () => {
    expect(
      canDecideApproval({
        ...ordinaryApprovalContext,
        approval: { ...ordinaryApprovalContext.approval, status: 'approved' }
      })
    ).toBe(false);
  });
});
