import {
  ApartmentOutlined,
  AppstoreOutlined,
  AuditOutlined,
  BuildOutlined,
  BulbOutlined,
  DashboardOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  TeamOutlined
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import type { Session } from '../contracts';

type Membership = Session['memberships'][number];

export function createAdminMenu(superAdmin: boolean, current?: Membership): MenuProps['items'] {
  return [
    ...(superAdmin
      ? [
          {
            type: 'group' as const,
            label: '平台管理',
            children: [
              { key: '/platform/overview', icon: <DashboardOutlined />, label: '平台概览' },
              { key: '/platform/token-usage', icon: <ThunderboltOutlined />, label: 'Token 统计' },
              { key: '/platform/organizations', icon: <ApartmentOutlined />, label: '组织管理' },
              { key: '/platform/models', icon: <BuildOutlined />, label: '模型配置' },
              { key: '/platform/skills', icon: <BulbOutlined />, label: '技能库' },
              { key: '/platform/settings', icon: <SettingOutlined />, label: '平台设置' },
              { key: '/platform/logins', icon: <AuditOutlined />, label: '登录日志' }
            ]
          }
        ]
      : []),
    ...(current
      ? [
          {
            type: 'group' as const,
            label: current.organizationName,
            children: [
              {
                key: `/organizations/${current.organizationId}/overview`,
                icon: <AppstoreOutlined />,
                label: '组织概览'
              },
              {
                key: `/organizations/${current.organizationId}/members`,
                icon: <TeamOutlined />,
                label: '成员与角色'
              },
              {
                key: `/organizations/${current.organizationId}/token-usage`,
                icon: <ThunderboltOutlined />,
                label: 'Token 统计'
              },
              {
                key: `/organizations/${current.organizationId}/skills`,
                icon: <BulbOutlined />,
                label: '组织技能'
              },
              {
                key: `/organizations/${current.organizationId}/audit`,
                icon: <AuditOutlined />,
                label: '审计日志'
              }
            ]
          }
        ]
      : [])
  ];
}

export function menuLabels(items: MenuProps['items']): string[] {
  return (items ?? []).flatMap((item) => {
    if (!item || !('label' in item)) return [];
    const own = typeof item.label === 'string' ? [item.label] : [];
    return 'children' in item ? own.concat(menuLabels(item.children)) : own;
  });
}
