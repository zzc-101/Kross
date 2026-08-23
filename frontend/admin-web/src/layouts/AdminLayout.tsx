import { useMemo, useState } from 'react';
import {
  BellOutlined,
  DownOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined
} from '@ant-design/icons';
import { Avatar, Button, Dropdown, Layout, Menu, Select, Space, Typography, type MenuProps } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AdminApiClient } from '../apiClient';
import type { Session } from '../contracts';
import { ProfileModal } from '../features/profile/ProfileModal';
import { createAdminMenu } from './navigation';

const { Header, Sider, Content } = Layout;

export function AdminLayout({
  api,
  session,
  onSession,
  onLogout
}: {
  api: AdminApiClient;
  session: Session;
  onSession(next: Session): void;
  onLogout(): Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const superAdmin = session.user.platformRole === 'super_admin';
  const memberships = session.memberships.filter((item) => item.role === 'admin' && item.status === 'active');
  const routeOrganizationId = location.pathname.match(/^\/organizations\/([^/]+)/)?.[1];
  const current = memberships.find((item) => item.organizationId === routeOrganizationId);
  const scope = location.pathname.startsWith('/platform')
    ? 'platform'
    : current?.organizationId || memberships[0]?.organizationId || 'platform';
  const menuItems = useMemo<MenuProps['items']>(
    () => createAdminMenu(superAdmin, current),
    [current, superAdmin]
  );
  const changeScope = (next: string) => {
    navigate(next === 'platform' ? '/platform/overview' : `/organizations/${next}/overview`);
    setMobileOpen(false);
  };
  const userMenu: MenuProps['items'] = [
    { key: 'profile', icon: <UserOutlined />, label: '个人资料' },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true }
  ];
  return (
    <Layout className="admin-shell">
      <Sider
        width={240}
        collapsedWidth={76}
        collapsed={collapsed}
        className={mobileOpen ? 'admin-sider mobile-open' : 'admin-sider'}
      >
        <div className="brand">
          <span className="brand-mark">K</span>
          {!collapsed && (
            <span>
              <strong>Kross</strong>
              <small>管理中心</small>
            </span>
          )}
        </div>
        {!collapsed && (
          <div className="scope-picker">
            <Typography.Text type="secondary">管理范围</Typography.Text>
            <Select
              value={scope}
              onChange={changeScope}
              options={[
                ...(superAdmin ? [{ value: 'platform', label: '平台（全部组织）' }] : []),
                ...memberships.map((item) => ({ value: item.organizationId, label: item.organizationName }))
              ]}
            />
          </div>
        )}
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => {
            navigate(key);
            setMobileOpen(false);
          }}
        />
        <div className="sider-user">
          <Avatar src={session.user.avatarUrl} icon={<UserOutlined />} />
          {!collapsed && (
            <div>
              <strong>{session.user.displayName}</strong>
              <small>{superAdmin ? '超级管理员' : '组织管理员'}</small>
            </div>
          )}
        </div>
      </Sider>
      <Layout>
        <Header className="admin-header">
          <Space>
            <Button
              className="desktop-collapse"
              type="text"
              aria-label="折叠菜单"
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((value) => !value)}
            />
            <Button
              className="mobile-collapse"
              type="text"
              aria-label="打开菜单"
              icon={mobileOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
              onClick={() => setMobileOpen((value) => !value)}
            />
            <div className="header-context">
              <strong>
                {location.pathname.startsWith('/platform')
                  ? '平台管理'
                  : current?.organizationName || '组织管理'}
              </strong>
              <span>{location.pathname.startsWith('/platform') ? '全局管理视图' : '组织管理视图'}</span>
            </div>
          </Space>
          <Space size="middle">
            <Button type="text" aria-label="通知" icon={<BellOutlined />} />
            <Dropdown
              menu={{
                items: userMenu,
                onClick: ({ key }) =>
                  key === 'profile' ? setProfileOpen(true) : key === 'logout' ? void onLogout() : undefined
              }}
              trigger={['click']}
            >
              <Button type="text">
                <Space>
                  <Avatar size="small" src={session.user.avatarUrl} icon={<UserOutlined />} />
                  <span className="header-name">{session.user.displayName}</span>
                  <DownOutlined />
                </Space>
              </Button>
            </Dropdown>
          </Space>
        </Header>
        <Content className="admin-content">
          <Outlet />
        </Content>
      </Layout>
      <ProfileModal
        open={profileOpen}
        api={api}
        session={session}
        onClose={() => setProfileOpen(false)}
        onSaved={(next) => {
          onSession(next);
          setProfileOpen(false);
        }}
      />
    </Layout>
  );
}
