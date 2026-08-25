import { Copy, Menu, Plus } from 'lucide-react';

import './TopBar.css';

export function TopBar({
  onOpenSidebar,
  onNew
}: {
  onOpenSidebar(): void;
  onNew(): void;
}) {
  return (
    <header className="libre-topbar">
      <button type="button" className="mobile-menu" aria-label="打开侧边栏" onClick={onOpenSidebar}><Menu /></button>
      <button type="button" className="header-icon" aria-label="复制当前对话链接" onClick={() => void navigator.clipboard?.writeText(location.href)}><Copy /></button>
      <button type="button" className="header-icon" aria-label="新对话" onClick={onNew}><Plus /></button>
      <span className="header-spacer" />
    </header>
  );
}
