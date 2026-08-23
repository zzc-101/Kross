import { useEffect, useMemo, useState } from 'react';
import { Result, Spin } from 'antd';
import { BrowserRouter } from 'react-router-dom';
import { AdminApiClient, AdminApiError } from '../apiClient';
import type { AuthConfig, Session } from '../contracts';
import { AuthPage } from '../auth/AuthPage';
import { workbenchUrl } from '../utils/format';
import { AdminRouter } from './AdminRouter';
import { AdminTheme } from './AdminTheme';

export function App() {
  const [config, setConfig] = useState<AuthConfig>();
  const [session, setSession] = useState<Session>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const api = useMemo(() => new AdminApiClient(), []);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const nextConfig = await api.authConfig();
        if (!active) return;
        setConfig(nextConfig);
        if (nextConfig.bootstrapRequired) setMode('register');
        const ssoError = new URLSearchParams(location.search).get('sso_error');
        if (ssoError) {
          setError(ssoError);
          history.replaceState(null, '', location.pathname);
        }
        try {
          setSession(await api.me());
        } catch (cause) {
          if (!(cause instanceof AdminApiError && cause.status === 401)) setError(messageOf(cause));
        }
      } catch (cause) {
        if (active) setError(messageOf(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [api]);
  const authenticate = async (action: () => Promise<Session>) => {
    setBusy(true);
    setError('');
    try {
      setSession(await action());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
  const logout = async () => {
    await api.logout().catch(() => undefined);
    setSession(undefined);
  };
  if (loading)
    return (
      <main className="loading-screen">
        <Spin size="large" />
        <h2>正在进入管理中心</h2>
        <p>正在验证身份与组织权限…</p>
      </main>
    );
  if (!session) {
    const canRegister = Boolean(
      (config?.registrationEnabled && !config?.ssoEnabled) || config?.bootstrapRequired
    );
    return (
      <AdminTheme>
        <AuthPage
          mode={canRegister && mode === 'register' ? 'register' : 'login'}
          canRegister={canRegister}
          ssoEnabled={Boolean(config?.ssoEnabled)}
          ssoDisplayName={config?.ssoDisplayName}
          error={error}
          busy={busy}
          onLogin={(username, password) => authenticate(() => api.login({ username, password }))}
          onRegister={(username, password, displayName) =>
            authenticate(() => api.register({ username, password, displayName }))
          }
          onToggle={() => {
            setError('');
            setMode((current) => (current === 'login' ? 'register' : 'login'));
          }}
        />
      </AdminTheme>
    );
  }
  if (!session.canAccessAdmin)
    return (
      <AdminTheme>
        <main className="standalone-result">
          <Result
            status="403"
            title="没有管理权限"
            subTitle="管理中心只对超级管理员和组织管理员开放。"
            extra={<a href={workbenchUrl()}>返回工作台</a>}
          />
        </main>
      </AdminTheme>
    );
  return (
    <AdminTheme>
      <BrowserRouter basename={routerBase()}>
        <AdminRouter api={api} session={session} onSession={setSession} onLogout={logout} />
      </BrowserRouter>
    </AdminTheme>
  );
}
function routerBase() {
  const base = import.meta.env.BASE_URL;
  return base === '/' ? '/' : base.replace(/\/$/, '');
}
function messageOf(error: unknown) {
  return error instanceof AdminApiError || error instanceof Error ? error.message : '发生未知错误';
}
