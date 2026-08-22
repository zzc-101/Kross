import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { AgentApiClient, ApiError } from '../api/client';
import type { Skill } from '../api/types';

type McpKind = 'stdio' | 'http';
type McpDraft = { id: string; kind: McpKind; command: string; args: string; url: string; disabled: boolean };

export function SkillsPanel({ api }: { api: AgentApiClient }) {
  const [tab, setTab] = useState<'skills' | 'mcp'>('skills');
  return (
    <div className="skills-panel">
      <div className="files-toolbar">
        <strong>扩展</strong>
        <div className="skills-tabs">
          <button type="button" className={tab === 'skills' ? 'active' : ''} onClick={() => setTab('skills')}>Skills</button>
          <button type="button" className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>MCP</button>
        </div>
      </div>
      {tab === 'skills' ? <SkillsTab api={api} /> : <McpTab api={api} />}
    </div>
  );
}

function SkillsTab({ api }: { api: AgentApiClient }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ id: '', name: '', description: '', content: '' });
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    setLoading(true);
    setError('');
    try {
      setSkills(await api.listSkills());
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '无法读取 Skills');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, [api]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.id.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api.upsertSkill(form.id.trim(), {
        name: form.name.trim() || form.id.trim(),
        description: form.description,
        content: form.content
      });
      setForm({ id: '', name: '', description: '', content: '' });
      await reload();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {error && <p className="files-error">{error}</p>}
      {loading && <p className="files-hint">正在读取 Skills…</p>}
      <div className="files-list">
        {skills.map((skill) => (
          <div key={skill.id} className="skill-row">
            <div>
              <strong>{skill.name}</strong>
              <small>{skill.id}</small>
              {skill.description && <p>{skill.description}</p>}
            </div>
            <button
              type="button"
              aria-label={`删除 ${skill.id}`}
              onClick={() => {
                void api.deleteSkill(skill.id).then(reload).catch((cause) => {
                  setError(cause instanceof Error ? cause.message : '删除失败');
                });
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {!loading && skills.length === 0 && <p className="files-hint">还没有 Skill。会写到 /work/skills。</p>}
      </div>
      <form className="clone-form" onSubmit={submit}>
        <label><span>标识</span><input required pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} placeholder="summarize" /></label>
        <label><span>名称</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Summarize" /></label>
        <label><span>说明</span><input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
        <label><span>SKILL.md 正文</span><textarea value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} rows={5} /></label>
        <button type="submit" disabled={saving}>{saving ? '保存中…' : '保存 Skill'}</button>
      </form>
    </>
  );
}

function McpTab({ api }: { api: AgentApiClient }) {
  const [servers, setServers] = useState<Record<string, Record<string, unknown>>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<McpDraft>({
    id: '', kind: 'stdio', command: '', args: '', url: '', disabled: false
  });

  const reload = async () => {
    setLoading(true);
    setError('');
    try {
      const next = await api.mcpConfig();
      setServers(next.servers);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '无法读取 MCP');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void reload(); }, [api]);

  const rows = useMemo(() => Object.entries(servers), [servers]);

  const persist = async (next: Record<string, Record<string, unknown>>) => {
    setSaving(true);
    setError('');
    try {
      const saved = await api.updateMcpConfig(next);
      setServers(saved.servers);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const id = draft.id.trim();
    if (!id) return;
    const config: Record<string, unknown> = { disabled: draft.disabled };
    if (draft.kind === 'http') {
      config.url = draft.url.trim();
    } else {
      config.command = draft.command.trim();
      const args = draft.args.split(/\s+/).map((item) => item.trim()).filter(Boolean);
      if (args.length > 0) config.args = args;
    }
    await persist({ ...servers, [id]: config });
    setDraft({ id: '', kind: 'stdio', command: '', args: '', url: '', disabled: false });
  };

  return (
    <>
      {error && <p className="files-error">{error}</p>}
      {loading && <p className="files-hint">正在读取 MCP…</p>}
      <p className="files-hint">配置写到 /work/.kross/mcp.json，容器重建后仍在。</p>
      <div className="files-list">
        {rows.map(([id, config]) => (
          <div key={id} className="skill-row">
            <div>
              <strong>{id}</strong>
              <small>{typeof config.command === 'string' ? config.command : typeof config.url === 'string' ? config.url : 'MCP'}</small>
            </div>
            <button
              type="button"
              aria-label={`删除 ${id}`}
              disabled={saving}
              onClick={() => {
                const next = { ...servers };
                delete next[id];
                void persist(next);
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {!loading && rows.length === 0 && <p className="files-hint">还没有 MCP 服务器。</p>}
      </div>
      <form className="clone-form" onSubmit={add}>
        <label><span>标识</span><input required pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="docs" /></label>
        <label>
          <span>类型</span>
          <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as McpKind })}>
            <option value="stdio">本地进程</option>
            <option value="http">HTTP</option>
          </select>
        </label>
        {draft.kind === 'stdio' ? (
          <>
            <label><span>命令</span><input required value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" /></label>
            <label><span>参数</span><input value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} placeholder="-y @modelcontextprotocol/server-filesystem /work" /></label>
          </>
        ) : (
          <label><span>URL</span><input required value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://mcp.example.com/mcp" /></label>
        )}
        <button type="submit" disabled={saving}><Plus size={14} />{saving ? '保存中…' : '添加并保存'}</button>
      </form>
    </>
  );
}
