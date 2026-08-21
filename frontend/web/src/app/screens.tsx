import { FormEvent } from 'react';

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
        <p>{displayName}，请让组织管理员用你的用户名登记到组织后再进入工作区。</p>
        <button className="primary" type="button" onClick={onLogout}>退出登录</button>
      </div>
    </main>
  );
}

function adminConsoleUrl() {
  const url = new URL(location.href);
  if (url.port === '8787') url.port = '8788';
  return url.origin;
}
