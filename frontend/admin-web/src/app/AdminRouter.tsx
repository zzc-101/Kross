import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom';
import { Result, Spin } from 'antd';
import { AdminApiClient } from '../apiClient';
import type { Session } from '../contracts';
import { AdminLayout } from '../layouts/AdminLayout';

type PageProps = { api: AdminApiClient };
const PlatformOverviewPage = lazyNamed(
  () => import('../pages/platform/overview/PlatformOverviewPage'),
  'PlatformOverviewPage'
);
const OrganizationsPage = lazy(async () => ({
  default: (await import('../pages/platform/organizations/OrganizationsPage')).OrganizationsPage
}));
const PlatformSettingsPage = lazyNamed(
  () => import('../pages/platform/settings/PlatformSettingsPage'),
  'PlatformSettingsPage'
);
const AuthLogsPage = lazyNamed(() => import('../pages/platform/login-logs/AuthLogsPage'), 'AuthLogsPage');
const OrganizationOverviewPage = lazyNamed(
  () => import('../pages/organization/overview/OrganizationOverviewPage'),
  'OrganizationOverviewPage'
);
const MembersPage = lazyNamed(() => import('../pages/organization/members/MembersPage'), 'MembersPage');
const ModelsPage = lazyNamed(() => import('../pages/platform/models/ModelsPage'), 'ModelsPage');
const AuditPage = lazyNamed(() => import('../pages/organization/audit/AuditPage'), 'AuditPage');
const TokenUsagePage = lazyNamed(() => import('../pages/token-usage/TokenUsagePage'), 'TokenUsagePage');
const PlatformSkillsPage = lazyNamed(
  () => import('../pages/platform/skills/PlatformSkillsPage'), 'PlatformSkillsPage'
);
const PlatformKnowledgePage = lazyNamed(
  () => import('../pages/platform/knowledge/PlatformKnowledgePage'),
  'PlatformKnowledgePage'
);
const OrganizationSkillsPage = lazyNamed(
  () => import('../pages/organization/skills/OrganizationSkillsPage'), 'OrganizationSkillsPage'
);

export function AdminRouter({
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
  const superAdmin = session.user.platformRole === 'super_admin';
  const memberships = session.memberships.filter((item) => item.role === 'admin' && item.status === 'active');
  const home = superAdmin
    ? '/platform/overview'
    : memberships[0]
      ? `/organizations/${memberships[0].organizationId}/overview`
      : '/no-organization';
  return (
    <Suspense
      fallback={
        <div className="route-loading">
          <Spin size="large" />
        </div>
      }
    >
      <Routes>
        <Route
          element={<AdminLayout api={api} session={session} onSession={onSession} onLogout={onLogout} />}
        >
          <Route index element={<Navigate to={home} replace />} />
          {superAdmin && (
            <Route path="platform">
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<PlatformOverviewPage api={api} />} />
              <Route path="token-usage" element={<TokenUsagePage api={api} platform />} />
              <Route
                path="organizations"
                element={<OrganizationsPage api={api} currentUsername={session.user.username} />}
              />
              <Route path="models" element={<ModelsPage api={api} />} />
              <Route path="skills" element={<PlatformSkillsPage api={api} />} />
              <Route path="knowledge" element={<PlatformKnowledgePage api={api} />} />
              <Route path="settings" element={<PlatformSettingsPage api={api} />} />
              <Route path="logins" element={<AuthLogsPage api={api} />} />
            </Route>
          )}
          <Route
            path="organizations/:organizationId"
            element={<OrganizationGuard api={api} session={session} />}
          >
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<OrganizationOverviewPage api={api} />} />
            <Route path="members" element={<MembersPage api={api} />} />
            <Route path="token-usage" element={<TokenUsagePage api={api} />} />
            <Route path="skills" element={<OrganizationSkillsPage api={api} />} />
            <Route path="audit" element={<AuditPage api={api} />} />
          </Route>
          <Route
            path="no-organization"
            element={
              <Result
                status="info"
                title="尚未加入可管理的组织"
                subTitle="请联系超级管理员为你分配组织管理员权限。"
              />
            }
          />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

function OrganizationGuard({ api, session }: { api: AdminApiClient; session: Session }) {
  const { organizationId = '' } = useParams();
  const allowed = session.memberships.some(
    (item) => item.organizationId === organizationId && item.role === 'admin' && item.status === 'active'
  );
  useEffect(() => {
    if (allowed) api.selectOrganization(organizationId);
  }, [allowed, api, organizationId]);
  if (!allowed)
    return (
      <Navigate
        to={session.user.platformRole === 'super_admin' ? '/platform/overview' : '/no-organization'}
        replace
      />
    );
  return <Outlet />;
}

function lazyNamed<T extends Record<K, ComponentType<PageProps>>, K extends keyof T>(
  loader: () => Promise<T>,
  name: K
) {
  return lazy(async () => ({ default: (await loader())[name] }));
}
