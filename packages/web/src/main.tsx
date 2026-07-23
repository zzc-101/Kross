import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { fetchSetupStatus } from './setupApi';
import { initializePwa } from './pwa';
import './styles.css';

initializePwa();

function Root() {
  const [token, setToken] = useState(() => localStorage.getItem('kross.token') ?? '');
  const [endpoint, setEndpoint] = useState(() => {
    const saved = localStorage.getItem('kross.endpoint');
    if (saved) return saved;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}/ws`;
  });
  const [loginError, setLoginError] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  if (!token) {
    return (
      <main className="login">
        <form onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const next = String(form.get('token') ?? '').trim();
          const nextEndpoint = String(form.get('endpoint') ?? '').trim();
          setConnecting(true);
          setLoginError(undefined);
          void fetchSetupStatus(nextEndpoint, next)
            .then(() => {
              localStorage.setItem('kross.token', next);
              localStorage.setItem('kross.endpoint', nextEndpoint);
              setEndpoint(nextEndpoint);
              setToken(next);
            })
            .catch((reason) => {
              setLoginError(
                reason instanceof Error
                  ? reason.message
                  : '无法连接 Gateway'
              );
            })
            .finally(() => setConnecting(false));
        }}>
          <div className="empty-mark">K</div>
          <h1>Kross Cloud</h1>
          <p>连接到你的自托管 Agent 网关</p>
          <label>网关地址<input name="endpoint" defaultValue={endpoint} required /></label>
          <label>访问令牌<input name="token" type="password" autoComplete="current-password" required /></label>
          {loginError && <p className="form-error" role="alert">{loginError}</p>}
          <button className="primary full" disabled={connecting}>
            {connecting ? '正在验证…' : '安全连接'}
          </button>
        </form>
      </main>
    );
  }
  return <App endpoint={endpoint} token={token} onLogout={() => {
    localStorage.removeItem('kross.token');
    setToken('');
  }} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
