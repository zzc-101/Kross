import { describe, expect, it } from 'vitest';
import type { Session } from '../contracts';
import { createAdminMenu, menuLabels } from './navigation';

const membership: Session['memberships'][number] = {
  id: 'membership-1',
  organizationId: 'org-1',
  organizationName: '星河科技',
  organizationSlug: 'xinghe',
  userId: 'user-1',
  role: 'admin',
  status: 'active',
  createdAt: '2026-08-23T00:00:00Z',
  updatedAt: '2026-08-23T00:00:00Z'
};

describe('管理端角色菜单', () => {
  it('超级管理员可以看到平台菜单和当前组织菜单', () => {
    const labels = menuLabels(createAdminMenu(true, membership));
    expect(labels).toContain('平台概览');
    expect(labels).toContain('平台设置');
    expect(labels).toContain('模型配置');
    expect(labels).toContain('技能库');
    expect(labels).toContain('组织技能');
    expect(labels).toContain('组织概览');
    expect(labels.filter((label) => label === 'Token 统计')).toHaveLength(2);
  });

  it('组织管理员不会看到平台级菜单', () => {
    const labels = menuLabels(createAdminMenu(false, membership));
    expect(labels).toContain('组织概览');
    expect(labels).toContain('成员与角色');
    expect(labels).toContain('组织技能');
    expect(labels.filter((label) => label === 'Token 统计')).toHaveLength(1);
    expect(labels).not.toContain('平台概览');
    expect(labels).not.toContain('平台设置');
    expect(labels).not.toContain('登录日志');
    expect(labels).not.toContain('模型配置');
    expect(labels).not.toContain('技能库');
  });
});
