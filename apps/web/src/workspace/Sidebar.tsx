import { useMemo, useState } from 'react';
import { Archive, MessageSquarePlus, Pencil, Puzzle, Search } from 'lucide-react';

import type { Conversation } from '../api/types';

export function Sidebar({
  conversations,
  activeId,
  open,
  onClose,
  onNew,
  onSelect,
  onArchive,
  onRename,
  onShowWorkspace
}: {
  conversations: Conversation[];
  activeId?: string;
  open: boolean;
  onClose(): void;
  onNew(): void;
  onSelect(id: string): void;
  onArchive(id: string): void;
  onRename(id: string, title: string): void;
  onShowWorkspace(): void;
}) {
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState('');
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return conversations;
    return conversations.filter((item) => item.title.toLowerCase().includes(needle));
  }, [conversations, query]);

  return (
    <>
      {open && <button type="button" className="sidebar-scrim" aria-label="关闭会话栏" onClick={onClose} />}
      <aside className={open ? 'sidebar open' : 'sidebar'}>
        <button type="button" className="new-chat" onClick={onNew}>
          <MessageSquarePlus size={16} />
          新对话
        </button>
        <label className="search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话"
          />
        </label>
        <div className="thread-scroll">
          {filtered.map((item) => (
            <div key={item.id} className={item.id === activeId ? 'thread-item active' : 'thread-item'}>
              {editingId === item.id ? (
                <input
                  className="thread-rename"
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
                <button type="button" className="thread-item-trigger" onClick={() => { onSelect(item.id); onClose(); }}>
                  {item.title}
                </button>
              )}
              <button
                type="button"
                className="thread-item-archive"
                aria-label="重命名"
                onClick={() => { setEditingId(item.id); setDraft(item.title); }}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                className="thread-item-archive"
                aria-label="归档"
                onClick={() => onArchive(item.id)}
              >
                <Archive size={14} />
              </button>
            </div>
          ))}
        </div>
        <button className="workspace-entry" type="button" onClick={onShowWorkspace}>
          <span><Puzzle size={16} /> 工作区</span>
          <small>技能 / MCP 装在盘上</small>
        </button>
      </aside>
    </>
  );
}
