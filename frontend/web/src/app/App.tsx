import { useEffect, useMemo, useState } from 'react';

import { AgentApiClient, ApiError } from '../api/client';
import type { AuthConfig, Me, Membership } from '../api/types';
import { WorkspacePage } from '../workspace/WorkspacePage';
import { AuthScreen, SuperAdminHint, WaitingForInvite } from './screens';

const ORG_KEY = 'kross.organization-id';

export function App() {
  const [config, setConfig] = useState<AuthConfig>();
  const [me, setMe] = useState<Me>();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [organizationId, setOrganizationId] = useState(() => localStorage.getItem(ORG_KEY) || '');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const api = useMemo(() => new AgentApiClient(), []);

  const applyMe = (next: Me) => {
    setMe(next);
    setMemberships(next.memberships);
    setOrganizationId((current) => {
      const selected = next.memberships.find((item) => item.organizationId === current)?.organizationId
        ?? next.memberships[0]?.organizationId
        ?? '';
      if (selected) {
        api.selectOrganization(selected);
        localStorage.setItem(ORG_KEY, selected);
      }
      return selected;
    });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const nextConfig = await api.authConfig();
        if (cancelled) return;
        setConfig(nextConfig);
        if (nextConfig.bootstrapRequired) setMode('register');
        const ssoError = new URLSearchParams(location.search).get('sso_error');
        if (ssoError) {
          setError(ssoError);
          history.replaceState(null, '', location.pathname);
        }
        try {
          applyMe(await api.me());
        } catch (cause) {
          if (cancelled) return;
          if (cause instanceof ApiError && cause.status === 401) {
            setMe(undefined);
            setMemberships([]);
          } else {
            setError(cause instanceof Error ? cause.message : '无法读取身份');
          }
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '无法连接控制面');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const canRegister = Boolean((config?.registrationEnabled && !config?.ssoEnabled) || config?.bootstrapRequired);

  const runAuth = async (action: () => Promise<Me>) => {
    setBusy(true);
    setError(undefined);
    try {
      applyMe(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await api.logout().catch(() => undefined);
    setMe(undefined);
    setMemberships([]);
    setOrganizationId('');
    localStorage.removeItem(ORG_KEY);
  };

  if (loading) {
    return <main className="gate"><div className="mark">K</div><h1>正在进入工作区</h1><p>加载身份与组织…</p></main>;
  }

  if (!me) {
    return (
      <AuthScreen
        mode={canRegister && mode === 'register' ? 'register' : 'login'}
        canRegister={canRegister}
        ssoEnabled={config?.ssoEnabled}
        ssoDisplayName={config?.ssoDisplayName}
        error={error}
        busy={busy}
        onLogin={(username, password) => runAuth(() => api.login({ username, password }))}
        onRegister={(username, password, displayName) => runAuth(() => api.register({ username, password, displayName }))}
        onToggle={() => {
          setError(undefined);
          setMode((current) => current === 'login' ? 'register' : 'login');
        }}
      />
    );
  }

  if (memberships.length === 0) {
    if (me.user.platformRole === 'super_admin') {
      return <SuperAdminHint displayName={me.user.displayName} onLogout={() => void logout()} />;
    }
    return <WaitingForInvite displayName={me.user.displayName} onLogout={() => void logout()} />;
  }

  return (
    <WorkspacePage
      api={api}
      memberships={memberships}
      organizationId={organizationId}
      displayName={me.user.displayName}
      username={me.user.username}
      onSelectOrganization={(id) => {
        api.selectOrganization(id);
        localStorage.setItem(ORG_KEY, id);
        setOrganizationId(id);
      }}
      onLogout={() => void logout()}
    />
  );
}
