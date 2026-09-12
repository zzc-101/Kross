import { useEffect, useMemo, useState } from 'react';

import './Sidebar.css';
import {
  Archive,
  BookOpen,
  BrainCircuit,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  MessagesSquare,
  PanelLeft,
  Paperclip,
  Pencil,
  Sparkles,
  SquarePen,
  UserRound
} from 'lucide-react';

import type { Conversation, Membership, Skill } from '../api/types';
import type { AgentApiClient } from '../api/client';
import { FilesPanel } from './FilesPanel';
import { KnowledgePanel } from './KnowledgePanel';
import { MemoryPanel } from './MemoryPanel';
import { SchedulesPanel } from './SchedulesPanel';
import { SkillsPanel } from './SkillsPanel';

export type SidebarSection =
  | 'conversations'
  | 'skills'
  | 'memory'
  | 'schedules'
  | 'files'
  | 'knowledge';

const RAIL: Array<{ id: SidebarSection; label: string; icon: typeof MessagesSquare }> = [
  { id: 'conversations', label: '对话', icon: MessagesSquare },
  { id: 'skills', label: '技能', icon: Sparkles },
  { id: 'memory', label: '记忆', icon: BrainCircuit },
  { id: 'schedules', label: '自动任务', icon: CalendarClock },
  { id: 'files', label: '文件与产物', icon: Paperclip }
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
  onApplySkill,
  api,
  section,
  onSection,
  skills,
  scheduleDraft,
  onConsumedScheduleDraft,
  onOpenScheduleConversation
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
  onApplySkill(skill: import('../api/types').Skill): void;
  api: AgentApiClient;
  section: SidebarSection;
  onSection(section: SidebarSection): void;
  skills: Skill[];
  scheduleDraft?: string;
  onConsumedScheduleDraft(): void;
  onOpenScheduleConversation(id: string): void;
}) {
  const [conversationsOpen, setConversationsOpen] = useState(true);
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [knowledgeEnabled, setKnowledgeEnabled] = useState(false);
  const [feishu, setFeishu] = useState<{ enabled: boolean; bound: boolean; code?: string }>({ enabled: false, bound: false });
  const [feishuBusy, setFeishuBusy] = useState(false);
  const [feishuError, setFeishuError] = useState('');
  const letter = (displayName.trim()[0] || username[0] || '?').toUpperCase();
  const visibleConversations = useMemo(
    () => conversations.filter((item) => item.title !== '新对话' || item.id === activeId),
    [activeId, conversations]
  );
  const rail = knowledgeEnabled
    ? [...RAIL, { id: 'knowledge' as const, label: '知识库', icon: BookOpen }]
    : RAIL;

  useEffect(() => {
    let cancelled = false;
    void api.knowledgeStatus()
      .then((status) => {
        if (!cancelled) setKnowledgeEnabled(status.enabled);
      })
      .catch(() => {
        if (!cancelled) setKnowledgeEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organizationId]);

  useEffect(() => {
    let cancelled = false;
    void api.listConnectors()
      .then((items) => {
        if (cancelled) return;
        const row = items.find((item) => item.channel === 'feishu');
        setFeishu({ enabled: Boolean(row?.enabled), bound: Boolean(row?.bound), code: undefined });
        setFeishuError('');
      })
      .catch(() => {
        if (!cancelled) setFeishu({ enabled: false, bound: false });
      });
    return () => {
      cancelled = true;
    };
  }, [api, organizationId]);

  useEffect(() => {
    if (!knowledgeEnabled && section === 'knowledge') {
      onSection('conversations');
    }
  }, [knowledgeEnabled, onSection, section]);

  return (
    <>
      {open && <button type="button" className="sidebar-scrim" aria-label="关闭侧边栏" onClick={onClose} />}
      <aside className={open ? 'libre-sidebar open' : 'libre-sidebar'}>
        <div className="icon-rail">
          <button type="button" className="rail-button" aria-label="收起侧边栏" onClick={onClose}><PanelLeft /></button>
          <button type="button" className="rail-button" aria-label="新对话" onClick={onNew}><SquarePen /></button>
          <div className="rail-divider" />
          <div className="rail-links">
            {rail.map(({ id, label, icon: Icon }) => (
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
                {feishu.enabled && (
                  <div className="account-connector">
                    <span>飞书</span>
                    {feishu.bound ? (
                      <p className="account-username">已绑定当前组织。在飞书私聊机器人发消息即可投递任务。</p>
                    ) : (
                      <p className="account-username">生成 6 位绑定码，发给飞书机器人完成绑定。</p>
                    )}
                    {feishu.code && <p className="account-bind-code">{feishu.code}</p>}
                    {feishuError && <p className="account-username">{feishuError}</p>}
                    <button
                      type="button"
                      disabled={feishuBusy}
                      onClick={() => {
                        setFeishuBusy(true);
                        setFeishuError('');
                        void api.createFeishuBindCode()
                          .then((result) => setFeishu((current) => ({ ...current, code: result.code })))
                          .catch((cause) => setFeishuError(cause instanceof Error ? cause.message : '无法生成绑定码'))
                          .finally(() => setFeishuBusy(false));
                      }}
                    >
                      {feishuBusy ? '生成中…' : feishu.bound ? '重新绑定' : '生成绑定码'}
                    </button>
                    {feishu.bound && (
                      <button
                        type="button"
                        disabled={feishuBusy}
                        onClick={() => {
                          setFeishuBusy(true);
                          setFeishuError('');
                          void api.unbindFeishu()
                            .then(() => setFeishu((current) => ({ ...current, bound: false, code: undefined })))
                            .catch((cause) => setFeishuError(cause instanceof Error ? cause.message : '解绑失败'))
                            .finally(() => setFeishuBusy(false));
                        }}
                      >
                        解除绑定
                      </button>
                    )}
                  </div>
                )}
                <button type="button" onClick={onLogout}>退出登录</button>
              </div>
            )}
          </div>
        </div>

        <div className="sidebar-panel">
          {section === 'files' ? (
            <FilesPanel api={api} />
          ) : section === 'skills' ? (
            <SkillsPanel api={api} onApply={onApplySkill} />
          ) : section === 'memory' ? (
            <MemoryPanel api={api} />
          ) : section === 'schedules' ? (
            <SchedulesPanel
              api={api}
              conversations={conversations}
              skills={skills}
              draftPrompt={scheduleDraft}
              onOpenConversation={onOpenScheduleConversation}
              onConsumedDraft={onConsumedScheduleDraft}
            />
          ) : section === 'knowledge' ? (
            <KnowledgePanel api={api} />
          ) : (
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
          )}
        </div>
      </aside>
    </>
  );
}
