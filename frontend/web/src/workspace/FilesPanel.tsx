import { useEffect, useState } from 'react';
import { ChevronRight, File, Folder, RefreshCw, X } from 'lucide-react';

import './Panel.css';
import './FilesPanel.css';

import { AgentApiClient, ApiError } from '../api/client';
import type { WorkspaceListing } from '../api/types';

export function FilesPanel({ api }: { api: AgentApiClient }) {
  const [path, setPath] = useState('.');
  const [listing, setListing] = useState<WorkspaceListing>();
  const [preview, setPreview] = useState<{ path: string; content: string }>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async (nextPath = path) => {
    setLoading(true);
    setError('');
    setPreview(undefined);
    try {
      const files = await api.listWorkspace(nextPath);
      setPath(files.path);
      setListing(files);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '无法读取文件');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load('.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const segments = path === '.' ? [] : path.split('/').filter(Boolean);
  const childPath = (name: string) => path === '.' ? name : `${path}/${name}`;

  const openFile = async (name: string) => {
    setError('');
    try {
      setPreview(await api.readWorkspaceFile(childPath(name)));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '无法预览文件');
    }
  };

  return (
    <div className="files-panel">
      <div className="files-toolbar">
        <div><strong>文件与产物</strong><small>Agent 生成的内容会保存在这里</small></div>
        <button type="button" aria-label="刷新" onClick={() => void load(path)}><RefreshCw size={14} /></button>
      </div>
      <div className="files-crumb">
        <button type="button" onClick={() => void load('.')}>我的文件</button>
        {segments.map((segment, index) => (
          <span key={`${segment}-${index}`}>
            <ChevronRight size={12} />
            <button type="button" onClick={() => void load(segments.slice(0, index + 1).join('/'))}>{segment}</button>
          </span>
        ))}
      </div>
      {error && <p className="files-error">{error}</p>}
      <div className="files-list">
        {loading && <p className="files-hint">正在读取文件…</p>}
        {!loading && listing?.entries.length === 0 && <p className="files-hint">这里还没有文件。可以在对话中让 Agent 创建文档、表格或其他产物。</p>}
        {!loading && listing?.entries.map((entry) => (
          <button
            type="button"
            key={entry.name}
            className="file-row"
            onClick={() => entry.type === 'dir' ? void load(childPath(entry.name)) : void openFile(entry.name)}
          >
            {entry.type === 'dir' ? <Folder size={15} /> : <File size={15} />}
            <span>{entry.name}</span>
            {entry.type === 'file' && entry.size !== undefined && <small>{formatBytes(entry.size)}</small>}
          </button>
        ))}
      </div>
      {preview && (
        <section className="file-preview">
          <header><strong>{preview.path.split('/').at(-1)}</strong><button type="button" aria-label="关闭预览" onClick={() => setPreview(undefined)}><X /></button></header>
          <pre>{preview.content}</pre>
        </section>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
