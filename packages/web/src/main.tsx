import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';

import './i18n';
import { App } from './App';
import { httpEndpoint } from './cloudClient';
import { LanguageSwitcher } from './components/app/LanguageSwitcher';
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
  const { t } = useTranslation();
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
            <div className="login-language"><LanguageSwitcher /></div>
            <div className="empty-mark">K</div>
            <CardTitle className="text-2xl">Kross Cloud</CardTitle>
            <CardDescription>{t('login.subtitle')}</CardDescription>
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
                      : t('login.connectionFailed')
                  );
                })
                .finally(() => setConnecting(false));
            }}>
              <Label className="login-field">
                {t('login.endpoint')}
                <Input name="endpoint" defaultValue={endpoint} required />
              </Label>
              <Label className="login-field">
                {t('login.token')}
                <Input name="token" type="password" autoComplete="current-password" required />
              </Label>
              {loginError && <p className="form-error" role="alert">{loginError}</p>}
              <Button className="w-full" disabled={connecting}>
                {connecting ? t('login.connecting') : t('login.connect')}
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
