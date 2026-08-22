import { FormEvent, useEffect, useState } from 'react';

import { AgentApiClient, ApiError } from '../api/client';
import type { AuthConfig, InvitePreview, Me } from '../api/types';

export function AuthScreen({
  mode,
  canRegister,
  ssoEnabled,
  ssoDisplayName,
  error,
  busy,
  onLogin,
  onRegister,
  onToggle
}: {
  mode: 'login' | 'register';
  canRegister: boolean;
  ssoEnabled?: boolean;
  ssoDisplayName?: string;
  error?: string;
  busy: boolean;
  onLogin(username: string, password: string): Promise<void>;
  onRegister(username: string, password: string, displayName: string): Promise<void>;
  onToggle(): void;
}) {
  const register = mode === 'register';
  const ssoLabel = ssoDisplayName || '企业账号';
  return (
    <main className="gate">
      <form
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const username = String(data.get('username') ?? '').trim();
          const password = String(data.get('password') ?? '');
          const displayName = String(data.get('displayName') ?? '').trim();
          if (!username || !password) return;
          if (register) void onRegister(username, password, displayName);
          else void onLogin(username, password);
        }}
      >
        <div className="mark">K</div>
        <h1>{register ? '创建账号' : '登录 Kross'}</h1>
        <p>
          {register
            ? '第一个注册的用户会成为超级管理员，之后是否开放注册由超级管理员决定。'
            : ssoEnabled
              ? `使用${ssoLabel}登录。超级管理员仍可用密码应急。`
              : '使用用户名和密码进入你的 Agent 工作区。'}
        </p>
        {error && <p className="gate-error">{error}</p>}
        {!register && ssoEnabled && (
          <a className="primary" href="/api/v2/auth/sso/start">使用{ssoLabel}登录</a>
        )}
        {(register || !ssoEnabled) && (
          <>
            <label>
              <span>用户名</span>
              <input name="username" required autoComplete="username" autoFocus pattern="[A-Za-z][A-Za-z0-9_-]{2,31}" />
            </label>
            {register && (
              <label>
                <span>昵称（可选）</span>
                <input name="displayName" autoComplete="nickname" />
              </label>
            )}
            <label>
              <span>密码</span>
              <input name="password" type="password" required minLength={8} autoComplete={register ? 'new-password' : 'current-password'} />
            </label>
            <button className="primary" type="submit" disabled={busy}>
              {busy ? '请稍候…' : register ? '注册并进入' : '登录'}
            </button>
          </>
        )}
        {!register && ssoEnabled && (
          <EmergencyLogin busy={busy} onLogin={onLogin} />
        )}
        {canRegister && (
          <p className="gate-switch">
            {register ? '已有账号？' : '还没有账号？'}
            <button type="button" className="gate-link" onClick={onToggle}>
              {register ? '去登录' : '注册'}
            </button>
          </p>
        )}
      </form>
    </main>
  );
}

function EmergencyLogin({
  busy,
  onLogin
}: {
  busy: boolean;
  onLogin(username: string, password: string): Promise<void>;
}) {
  return (
    <details className="gate-emergency">
      <summary>管理员应急登录</summary>
      <label>
        <span>用户名</span>
        <input name="username" required autoComplete="username" pattern="[A-Za-z][A-Za-z0-9_-]{2,31}" />
      </label>
      <label>
        <span>密码</span>
        <input name="password" type="password" required minLength={8} autoComplete="current-password" />
      </label>
      <button className="primary" type="submit" disabled={busy}>{busy ? '请稍候…' : '应急登录'}</button>
    </details>
  );
}

export function SuperAdminHint({
  displayName,
  onLogout
}: {
  displayName: string;
  onLogout(): void;
}) {
  return (
    <main className="gate">
      <div className="gate-card">
        <div className="mark">K</div>
        <h1>去管理中心创建组织</h1>
        <p>{displayName}，超级管理员默认不属于任何组织，也不能查看组织对话。请到管理中心创建组织并指定组织管理员。</p>
        <a className="primary" href={adminConsoleUrl()}>打开管理中心</a>
        <button className="primary" type="button" onClick={onLogout}>退出登录</button>
      </div>
    </main>
  );
}

export function WaitingForInvite({
  displayName,
  onLogout
}: {
  displayName: string;
  onLogout(): void;
}) {
  return (
    <main className="gate">
      <div className="gate-card">
        <div className="mark">K</div>
        <h1>等待加入组织</h1>
        <p>{displayName}，请让组织管理员用你的用户名登记到组织，或打开他们发给你的邀请链接后再进入工作区。</p>
        <button className="primary" type="button" onClick={onLogout}>退出登录</button>
      </div>
    </main>
  );
}

export function InvitePage({
  token,
  me,
  config,
  api,
  busy,
  error,
  onAccepted,
  onEnterWorkspace,
  onLogout
}: {
  token: string;
  me?: Me;
  config?: AuthConfig;
  api: AgentApiClient;
  busy: boolean;
  error?: string;
  onAccepted(next: Me): void;
  onEnterWorkspace(): void;
  onLogout(): void;
}) {
  const [preview, setPreview] = useState<InvitePreview>();
  const [loading, setLoading] = useState(true);
  const [localError, setLocalError] = useState<string>();
  const [joining, setJoining] = useState(false);
  const message = localError || error;
  const expired = preview ? new Date(preview.expiresAt).getTime() < Date.now() : false;
  const alreadyMember = Boolean(
    preview && me?.memberships.some((item) => item.organizationSlug === preview.organizationSlug)
  );
  const ssoEnabled = Boolean(config?.ssoEnabled);
  const ssoLabel = config?.ssoDisplayName || '企业账号';
  const roleLabel = preview?.role === 'admin' ? '组织管理员' : '成员';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLocalError(undefined);
    void api.previewInvite(token)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch((cause) => {
        if (!cancelled) {
          setPreview(undefined);
          setLocalError(cause instanceof Error ? cause.message : '邀请链接无效');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, token]);

  const join = async (credentials?: { username: string; password: string; displayName: string }) => {
    setJoining(true);
    setLocalError(undefined);
    try {
      onAccepted(await api.acceptInvite(token, credentials));
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'membership_exists') {
        onEnterWorkspace();
        return;
      }
      setLocalError(cause instanceof Error ? cause.message : '无法加入组织');
    } finally {
      setJoining(false);
    }
  };

  if (loading) {
    return <main className="gate"><div className="mark">K</div><h1>正在打开邀请</h1><p>读取组织信息…</p></main>;
  }

  if (!preview) {
    return (
      <main className="gate">
        <div className="gate-card">
          <div className="mark">K</div>
          <h1>邀请链接无效</h1>
          <p>{message || '链接不存在或已被撤销。'}</p>
          <a className="primary" href="/">返回登录</a>
        </div>
      </main>
    );
  }

  if (alreadyMember) {
    return (
      <main className="gate">
        <div className="gate-card">
          <div className="mark">K</div>
          <h1>你已在 {preview.organizationName}</h1>
          <p>可以直接进入工作区。</p>
          <button className="primary" type="button" onClick={onEnterWorkspace}>进入工作区</button>
        </div>
      </main>
    );
  }

  if (preview.accepted || expired) {
    return (
      <main className="gate">
        <div className="gate-card">
          <div className="mark">K</div>
          <h1>{preview.accepted ? '邀请已使用' : '邀请已过期'}</h1>
          <p>请让 {preview.organizationName} 的管理员重新生成链接。</p>
          {me
            ? <button className="primary" type="button" onClick={onLogout}>退出登录</button>
            : <a className="primary" href="/">返回登录</a>}
        </div>
      </main>
    );
  }

  return (
    <main className="gate">
      <div className="gate-card">
        <div className="mark">K</div>
        <h1>加入 {preview.organizationName}</h1>
        <p>角色为{roleLabel}。链接将于 {formatInviteDate(preview.expiresAt)} 过期。</p>
        {message && <p className="gate-error">{message}</p>}
        {me ? (
          <>
            <p>当前账号：{me.user.displayName}（{me.user.username}）</p>
            <button className="primary" type="button" disabled={joining} onClick={() => void join()}>
              {joining ? '正在加入…' : '加入组织'}
            </button>
            <button className="primary" type="button" onClick={onLogout}>换一个账号</button>
          </>
        ) : ssoEnabled ? (
          <>
            <p>请先用{ssoLabel}登录，然后再打开此邀请链接。</p>
            <a className="primary" href={`/api/v2/auth/sso/start?next=${encodeURIComponent(`/invite/${token}`)}`}>
              使用{ssoLabel}登录
            </a>
          </>
        ) : (
          <form
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const username = String(data.get('username') ?? '').trim();
              const password = String(data.get('password') ?? '');
              const displayName = String(data.get('displayName') ?? '').trim();
              if (!username || !password) return;
              void join({ username, password, displayName });
            }}
          >
            <p>已有账号请填写用户名和密码；新用户会同时创建账号并加入，即使平台已关闭自助注册。</p>
            <label>
              <span>用户名</span>
              <input name="username" required autoComplete="username" autoFocus pattern="[A-Za-z][A-Za-z0-9_-]{2,31}" />
            </label>
            <label>
              <span>昵称（新账号可选）</span>
              <input name="displayName" autoComplete="nickname" />
            </label>
            <label>
              <span>密码</span>
              <input name="password" type="password" required minLength={8} autoComplete="current-password" />
            </label>
            <button className="primary" type="submit" disabled={joining || busy}>
              {joining ? '正在加入…' : '登录或注册并加入'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

function formatInviteDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function adminConsoleUrl() {
  if (location.port === '4173') {
    const url = new URL(location.href);
    url.port = '4174';
    return url.origin;
  }
  return `${location.origin}/admin/`;
}
