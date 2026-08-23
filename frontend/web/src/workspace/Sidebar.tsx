import { useMemo, useState } from 'react';
import {
  Archive,
  Bookmark,
  Bot,
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
import type { AgentApiClient } from '../api/client';
import { ComingSoonPanel } from './ComingSoonPanel';
import { FilesPanel } from './FilesPanel';
import { MemoryPanel } from './MemoryPanel';
import { SkillsPanel } from './SkillsPanel';

export type SidebarSection =
  | 'conversations'
  | 'agents'
  | 'prompts'
  | 'notes'
  | 'memory'
  | 'bookmarks'
  | 'files';

const RAIL: Array<{ id: SidebarSection; label: string; icon: typeof MessagesSquare }> = [
  { id: 'conversations', label: '对话', icon: MessagesSquare },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'prompts', label: '提示词', icon: ScrollText },
  { id: 'notes', label: '笔记', icon: NotebookPen },
  { id: 'memory', label: '记忆', icon: BrainCircuit },
  { id: 'bookmarks', label: '书签', icon: Bookmark },
  { id: 'files', label: '文件', icon: Paperclip }
];

export function Sidebar({
  conversations,
  activeId,
  open,
  memberships,
  organizationId,
  displayName,
  username,
  avatarUrl,
  gender,
  phone,
  onClose,
  onNew,
  onSelect,
  onArchive,
  onRename,
  onSelectOrganization,
  onLogout,
  onSaveProfile,
  onPlaceholder,
  api,
  section,
  onSection
}: {
  conversations: Conversation[];
  activeId?: string;
  open: boolean;
  memberships: Membership[];
  organizationId: string;
  displayName: string;
  username: string;
  avatarUrl?: string;
  gender?: string;
  phone?: string;
  onClose(): void;
  onNew(): void;
  onSelect(id: string): void;
  onArchive(id: string): void;
  onRename(id: string, title: string): void;
  onSelectOrganization(id: string): void;
  onLogout(): void;
  onSaveProfile(input: { displayName: string; avatarUrl: string; gender: string; phone: string }): Promise<void>;
  onPlaceholder(title: string, body: string): void;
  api: AgentApiClient;
  section: SidebarSection;
  onSection(section: SidebarSection): void;
}) {
  const [conversationsOpen, setConversationsOpen] = useState(true);
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState('');
  const letter = (displayName.trim()[0] || username[0] || '?').toUpperCase();
  const visibleConversations = useMemo(
    () => conversations.filter((item) => item.title !== '新对话' || item.id === activeId),
    [activeId, conversations]
  );

  return (
    <>
      {open && <button type="button" className="sidebar-scrim" aria-label="关闭侧边栏" onClick={onClose} />}
      <aside className={open ? 'libre-sidebar open' : 'libre-sidebar'}>
        <div className="icon-rail">
          <button type="button" className="rail-button" aria-label="收起侧边栏" onClick={onClose}><PanelLeft /></button>
          <button type="button" className="rail-button" aria-label="新对话" onClick={onNew}><SquarePen /></button>
          <div className="rail-divider" />
          <div className="rail-links">
            {RAIL.map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                key={id}
                className={section === id ? 'rail-button active' : 'rail-button'}
                aria-label={label}
                aria-pressed={section === id}
                onClick={() => onSection(id)}
              >
                <Icon />
              </button>
            ))}
          </div>
          <div className="rail-account">
            <button type="button" className="account-avatar" aria-label="账户与工作区" onClick={() => setAccountOpen((value) => !value)}>
              {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{letter}</span>}
            </button>
            {accountOpen && (
              <div className="account-popover">
                <div className="account-title"><UserRound size={16} /><strong>{displayName}</strong></div>
                <p className="account-username">{username}</p>
                <form
                  className="account-profile"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    setSavingProfile(true);
                    setProfileError('');
                    void onSaveProfile({
                      displayName: String(data.get('displayName') ?? '').trim() || displayName,
                      avatarUrl: String(data.get('avatarUrl') ?? '').trim(),
                      gender: String(data.get('gender') ?? 'unspecified'),
                      phone: String(data.get('phone') ?? '').trim()
                    }).catch((cause) => {
                      setProfileError(cause instanceof Error ? cause.message : '保存失败');
                    }).finally(() => setSavingProfile(false));
                  }}
                >
                  <label>
                    <span>昵称</span>
                    <input name="displayName" defaultValue={displayName} maxLength={64} required />
                  </label>
                  <label>
                    <span>头像 URL</span>
                    <input name="avatarUrl" defaultValue={avatarUrl ?? ''} placeholder="https://" />
                  </label>
                  <label>
                    <span>性别</span>
                    <select name="gender" defaultValue={gender ?? 'unspecified'}>
                      <option value="unspecified">未说明</option>
                      <option value="male">男</option>
                      <option value="female">女</option>
                      <option value="other">其他</option>
                    </select>
                  </label>
                  <label>
                    <span>手机号</span>
                    <input name="phone" defaultValue={phone ?? ''} inputMode="tel" />
                  </label>
                  {profileError && <p className="account-username">{profileError}</p>}
                  <button type="submit" disabled={savingProfile}>{savingProfile ? '保存中…' : '保存资料'}</button>
                </form>
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
          {section === 'files' ? (
            <FilesPanel api={api} />
          ) : section === 'prompts' ? (
            <SkillsPanel api={api} />
          ) : section === 'agents' ? (
            <ComingSoonPanel title="Agents" body="每人目前只有一个长期 Agent 工作区。多 Agent 切换会作为后续入口单独接入，不会再跳到空页面。" />
          ) : section === 'notes' ? (
            <ComingSoonPanel title="笔记" body="笔记将与对话分开保存、可检索。这一期只恢复入口，实现按你指定的顺序逐项接入。" />
          ) : section === 'memory' ? (
            <MemoryPanel api={api} />
          ) : section === 'bookmarks' ? (
            <ComingSoonPanel title="书签" body="书签用来固定对话、文件或网页。入口已恢复，能力尚未接入。" />
          ) : (
            <>
              <button
                type="button"
                className="bookmark-head"
                aria-label="书签"
                onClick={() => onSection('bookmarks')}
              >
                <Bookmark />
              </button>
              <div className="sidebar-section projects-section">
                <div className="section-heading">
                  <button
                    type="button"
                    onClick={() => onPlaceholder('项目', '项目将按 /work 下的目录组织。入口先恢复，独立项目模型尚未接入。')}
                  >
                    <span>Projects</span><ChevronRight />
                  </button>
                  <div>
                    <button type="button" aria-label="打开项目" onClick={() => onSection('files')}><Folder /></button>
                    <button
                      type="button"
                      aria-label="新建项目"
                      onClick={() => onPlaceholder('新建项目', '新建项目会在 /work 下建目录。入口先恢复，向导尚未接入。')}
                    >
                      <FolderPlus />
                    </button>
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
            </>
          )}
        </div>
      </aside>
    </>
  );
}
