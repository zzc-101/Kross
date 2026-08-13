import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { initializePwa } from './pwa';
import './styles.css';

initializePwa();

function Root() {
  const [devUserId, setDevUserId] = useState(() => localStorage.getItem('kross.dev-user-id') || import.meta.env.VITE_DEV_USER_ID || 'demo-user');
  if (!devUserId) return <main className="identity-page"><form onSubmit={(event) => { event.preventDefault(); const id = String(new FormData(event.currentTarget).get('userId') ?? '').trim(); if (id) { localStorage.setItem('kross.dev-user-id', id); setDevUserId(id); } }}><div className="empty-mark">K</div><h1>进入 Kross Work</h1><p>开发环境身份由控制面显式启用。工作台与管理端必须使用同一个用户 ID，默认是 demo-user。</p><label><span>开发用户 ID</span><input name="userId" required pattern="[A-Za-z0-9][A-Za-z0-9_-]*" defaultValue="demo-user" autoFocus /></label><button className="primary">继续</button></form></main>;
  return <App devUserId={devUserId} onChangeIdentity={() => { localStorage.removeItem('kross.dev-user-id'); setDevUserId(''); }} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
