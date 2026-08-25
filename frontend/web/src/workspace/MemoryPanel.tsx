import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';

import './Panel.css';
import './MemoryPanel.css';

import { AgentApiClient, ApiError } from '../api/client';
import type { AgentMemory, MemoryKind } from '../api/types';

const KIND_LABEL: Record<MemoryKind, string> = {
  preference: '偏好',
  fact: '事实'
};

const SOURCE_LABEL: Record<AgentMemory['source'], string> = {
  manual: '手写',
  remember: '记住',
  extract: '休眠抽取'
};

export function MemoryPanel({ api }: { api: AgentApiClient }) {
  const [items, setItems] = useState<AgentMemory[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ kind: 'fact' as MemoryKind, content: '' });
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState('');

  const reload = async () => {
    setLoading(true);
    setError('');
    try {
      setItems(await api.listMemories());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '无法读取记忆');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, [api]);

  const grouped = useMemo(() => ({
    preference: items.filter((item) => item.kind === 'preference'),
    fact: items.filter((item) => item.kind === 'fact')
  }), [items]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.content.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api.createMemory({ kind: form.kind, content: form.content.trim() });
      setForm({ kind: form.kind, content: '' });
      await reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const saveEdit = async (item: AgentMemory) => {
    const content = draft.trim();
    if (!content || content === item.content) {
      setEditingId(undefined);
      return;
    }
    setError('');
    try {
      await api.patchMemory(item.id, { content });
      setEditingId(undefined);
      await reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '更新失败');
    }
  };

  const forget = async (item: AgentMemory) => {
    setError('');
    try {
      await api.forgetMemory(item.id);
      await reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '忘记失败');
    }
  };

  return (
    <div className="workspace-panel memory-panel">
      <div className="files-toolbar">
        <strong>记忆</strong>
      </div>
      <p className="files-hint">永久保存，只属于你。对话里说「记住这个」会立刻写入；Worker 休眠时会从你的发言里巩固偏好和事实。</p>
      {error && <p className="files-error">{error}</p>}
      {loading && <p className="files-hint">正在读取记忆…</p>}
      <MemoryGroup
        title="偏好"
        items={grouped.preference}
        editingId={editingId}
        draft={draft}
        onDraft={setDraft}
        onEdit={(item) => { setEditingId(item.id); setDraft(item.content); }}
        onSave={saveEdit}
        onCancel={() => setEditingId(undefined)}
        onForget={forget}
      />
      <MemoryGroup
        title="事实"
        items={grouped.fact}
        editingId={editingId}
        draft={draft}
        onDraft={setDraft}
        onEdit={(item) => { setEditingId(item.id); setDraft(item.content); }}
        onSave={saveEdit}
        onCancel={() => setEditingId(undefined)}
        onForget={forget}
      />
      {!loading && items.length === 0 && <p className="files-hint">还没有记忆。可以在下面记一条，或在对话里让我记住。</p>}
      <form className="memory-form" onSubmit={submit}>
        <label>
          <span>类型</span>
          <select
            value={form.kind}
            onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value as MemoryKind }))}
          >
            <option value="fact">事实</option>
            <option value="preference">偏好</option>
          </select>
        </label>
        <label>
          <span>内容</span>
          <textarea
            value={form.content}
            maxLength={2000}
            rows={3}
            placeholder="例如：请用中文回复，或这个仓库用 Java 21"
            onChange={(event) => setForm((current) => ({ ...current, content: event.target.value }))}
          />
        </label>
        <button type="submit" disabled={saving || !form.content.trim()}>
          <Plus size={14} />{saving ? '保存中…' : '记下'}
        </button>
      </form>
    </div>
  );
}

function MemoryGroup({
  title,
  items,
  editingId,
  draft,
  onDraft,
  onEdit,
  onSave,
  onCancel,
  onForget
}: {
  title: string;
  items: AgentMemory[];
  editingId?: string;
  draft: string;
  onDraft(value: string): void;
  onEdit(item: AgentMemory): void;
  onSave(item: AgentMemory): void;
  onCancel(): void;
  onForget(item: AgentMemory): void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="memory-group">
      <p className="memory-group-title">{title}</p>
      <div className="files-list">
        {items.map((item) => (
          <div key={item.id} className="memory-row">
            <div>
              {editingId === item.id ? (
                <textarea
                  value={draft}
                  autoFocus
                  rows={3}
                  onChange={(event) => onDraft(event.target.value)}
                  onBlur={() => onSave(item)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      onSave(item);
                    }
                    if (event.key === 'Escape') onCancel();
                  }}
                />
              ) : (
                <p className="memory-content">{item.content}</p>
              )}
              <small>{KIND_LABEL[item.kind]} · {SOURCE_LABEL[item.source]}</small>
            </div>
            <div className="memory-actions">
              <button type="button" aria-label="编辑记忆" onClick={() => onEdit(item)}><Pencil /></button>
              <button type="button" aria-label="忘记这条" onClick={() => onForget(item)}><Trash2 /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
