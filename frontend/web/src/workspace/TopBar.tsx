import { Copy, Menu, MessageCircleDashed, Plus } from 'lucide-react';

export function TopBar({ onOpenSidebar, onNew }: { onOpenSidebar(): void; onNew(): void }) {
  return (
    <header className="libre-topbar">
      <button type="button" className="mobile-menu" aria-label="打开侧边栏" onClick={onOpenSidebar}><Menu /></button>
      <button type="button" className="model-selector" aria-label="选择模型"><img src="/openai.svg" alt="" /><strong>gpt-5.5</strong></button>
      <button type="button" className="header-icon" aria-label="复制当前对话链接" onClick={() => void navigator.clipboard?.writeText(location.href)}><Copy /></button>
      <button type="button" className="header-icon" aria-label="新对话" onClick={onNew}><Plus /></button>
      <span className="header-spacer" />
      <button type="button" className="header-icon temporary-chat" aria-label="临时对话"><MessageCircleDashed /></button>
    </header>
  );
}
