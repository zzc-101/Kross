import { useMemo, useState } from 'react';
import {
  Archive,
  Bot,
  Bookmark,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MessagesSquare,
  NotebookPen,
  PanelLeft,
  Paperclip,
  Pencil,
  ScrollText,
  SquarePen,
  UserRound
} from 'lucide-react';

import type { Conversation, Membership } from '../api/types';

export function Sidebar({
  conversations,
  activeId,
  open,
  memberships,
  organizationId,
  displayName,
  username,
  onClose,
  onNew,
  onSelect,
  onArchive,
  onRename,
  onSelectOrganization,
  onLogout,
  onShowWorkspace
}: {
  conversations: Conversation[];
  activeId?: string;
  open: boolean;
  memberships: Membership[];
  organizationId: string;
  displayName: string;
  username: string;
  onClose(): void;
  onNew(): void;
  onSelect(id: string): void;
  onArchive(id: string): void;
  onRename(id: string, title: string): void;
  onSelectOrganization(id: string): void;
  onLogout(): void;
  onShowWorkspace(): void;
}) {
  const [conversationsOpen, setConversationsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const visibleConversations = useMemo(
    () => conversations.filter((item) => item.title !== '新对话' || item.id === activeId),
    [activeId, conversations]
  );

  const railLinks = [
    { label: '对话', icon: MessagesSquare, active: true, action: () => setConversationsOpen(true) },
    { label: 'Agents', icon: Bot, action: onShowWorkspace },
    { label: '提示词', icon: ScrollText, action: onShowWorkspace },
    { label: '笔记', icon: NotebookPen, action: onShowWorkspace },
    { label: '记忆', icon: BrainCircuit, action: onShowWorkspace },
    { label: '书签', icon: Bookmark, action: onShowWorkspace },
    { label: '文件', icon: Paperclip, action: onShowWorkspace }
  ];

  return (
    <>
      {open && <button type="button" className="sidebar-scrim" aria-label="关闭侧边栏" onClick={onClose} />}
      <aside className={open ? 'libre-sidebar open' : 'libre-sidebar'}>
        <div className="icon-rail">
          <button type="button" className="rail-button" aria-label="收起侧边栏" onClick={onClose}><PanelLeft /></button>
          <button type="button" className="rail-button" aria-label="新对话" onClick={onNew}><SquarePen /></button>
          <div className="rail-divider" />
          <div className="rail-links">
            {railLinks.map(({ label, icon: Icon, active, action }) => (
              <button type="button" key={label} className={active ? 'rail-button active' : 'rail-button'} aria-label={label} aria-pressed={active} onClick={action}>
                <Icon />
              </button>
            ))}
          </div>
          <div className="rail-account">
            <button type="button" className="account-avatar" aria-label="账户与工作区" onClick={() => setAccountOpen((value) => !value)}>
              <img src="/icon.svg" alt="Kross" />
            </button>
            {accountOpen && (
              <div className="account-popover">
                <div className="account-title"><UserRound size={16} /><strong>{displayName}</strong></div>
                <p className="account-username">{username}</p>
                <label>
                  <span>组织</span>
                  <select value={organizationId} onChange={(event) => onSelectOrganization(event.target.value)}>
                    {memberships.map((item) => <option key={item.id} value={item.organizationId}>{item.organizationName} · {item.role === 'admin' ? '组织管理员' : '成员'}</option>)}
                  </select>
                </label>
                <button type="button" onClick={onLogout}>退出登录</button>
              </div>
            )}
          </div>
        </div>

        <div className="sidebar-panel">
          <button type="button" className="bookmark-head" aria-label="书签"><Bookmark /></button>
          <div className="sidebar-section projects-section">
            <div className="section-heading">
              <button type="button"><span>Projects</span><ChevronRight /></button>
              <div>
                <button type="button" aria-label="打开项目" onClick={onShowWorkspace}><Folder /></button>
                <button type="button" aria-label="新建项目" onClick={onShowWorkspace}><FolderPlus /></button>
              </div>
            </div>
          </div>
          <div className="sidebar-section conversation-section">
            <button type="button" className="section-toggle" aria-expanded={conversationsOpen} onClick={() => setConversationsOpen((value) => !value)}>
              <span>对话</span>{conversationsOpen ? <ChevronDown /> : <ChevronRight />}
            </button>
            {conversationsOpen && (
              <div className="conversation-list">
                {visibleConversations.map((item) => (
                  <div key={item.id} className={item.id === activeId ? 'conversation-row active' : 'conversation-row'}>
                    {editingId === item.id ? (
                      <input
                        value={draft}
                        autoFocus
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => {
                          const title = draft.trim();
                          if (title && title !== item.title) onRename(item.id, title);
                          setEditingId(undefined);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur();
                          if (event.key === 'Escape') setEditingId(undefined);
                        }}
                      />
                    ) : (
                      <button type="button" className="conversation-trigger" onClick={() => { onSelect(item.id); onClose(); }}>{item.title}</button>
                    )}
                    <button type="button" className="conversation-action" aria-label="重命名" onClick={() => { setDraft(item.title); setEditingId(item.id); }}><Pencil /></button>
                    <button type="button" className="conversation-action" aria-label="归档" onClick={() => onArchive(item.id)}><Archive /></button>
                  </div>
                ))}
                {visibleConversations.length === 0 && <p className="conversation-empty">还没有对话</p>}
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
