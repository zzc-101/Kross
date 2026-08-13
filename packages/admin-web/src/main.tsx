import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

function Root() {
  const [userId, setUserId] = useState(() => localStorage.getItem('kross-admin-user') ?? 'demo-user');
  const save = (next: string) => { localStorage.setItem('kross-admin-user', next); setUserId(next); };
  return <App devUserId={userId} onChangeIdentity={save} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
