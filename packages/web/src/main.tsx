import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { httpEndpoint } from './cloudClient';
import { Button } from './components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from './components/ui/card';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { fetchSetupStatus } from './setupApi';
import { initializePwa } from './pwa';
import './styles.css';

initializePwa();

function Root() {
  const [token, setToken] = useState(() => localStorage.getItem('kross.token') ?? '');
  const [endpoint, setEndpoint] = useState(() => {
    const saved = localStorage.getItem('kross.endpoint');
    if (saved) {
      const migrated = httpEndpoint(saved);
      if (migrated !== saved) {
        localStorage.setItem('kross.endpoint', migrated);
      }
      return migrated;
    }
    return `${location.protocol}//${location.host}`;
  });
  const [loginError, setLoginError] = useState<string>();
  const [connecting, setConnecting] = useState(false);
  if (!token) {
    return (
      <main className="login">
        <Card className="login-card">
          <CardHeader className="text-center">
            <div className="empty-mark">K</div>
            <CardTitle className="text-2xl">Kross Cloud</CardTitle>
            <CardDescription>连接到你的自托管 Agent 网关</CardDescription>
          </CardHeader>
          <CardContent>
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
              <Label className="login-field">
                网关地址
                <Input name="endpoint" defaultValue={endpoint} required />
              </Label>
              <Label className="login-field">
                访问令牌
                <Input name="token" type="password" autoComplete="current-password" required />
              </Label>
              {loginError && <p className="form-error" role="alert">{loginError}</p>}
              <Button className="w-full" disabled={connecting}>
                {connecting ? '正在验证…' : '安全连接'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>
    );
  }
  return <App endpoint={endpoint} token={token} onLogout={() => {
    localStorage.removeItem('kross.token');
    setToken('');
  }} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
