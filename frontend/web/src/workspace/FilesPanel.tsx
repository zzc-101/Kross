import { useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  Download,
  File,
  Folder,
  FolderPlus,
  RefreshCw,
  Trash2,
  Upload,
  X
} from 'lucide-react';

import './Panel.css';
import './FilesPanel.css';

import { AgentApiClient, ApiError } from '../api/client';
import type { WorkspaceListing } from '../api/types';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export function FilesPanel({ api }: { api: AgentApiClient }) {
  const [path, setPath] = useState('.');
  const [listing, setListing] = useState<WorkspaceListing>();
  const [preview, setPreview] = useState<
    { path: string; kind: 'text'; content: string } | { path: string; kind: 'image'; url: string }
  >();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const clearPreview = () => {
    setPreview(undefined);
  };

  const load = async (nextPath = path) => {
    setLoading(true);
    setError('');
    clearPreview();
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

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setError('');
    try {
      for (const file of files) {
        await api.uploadWorkspaceFile(path, file);
      }
      await load(path);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '上传失败');
    }
  };

  const openFile = async (name: string) => {
    setError('');
    const target = childPath(name);
    try {
      if (IMAGE_EXT.test(name)) {
        setPreview({ path: target, kind: 'image', url: api.workspaceFileContentUrl(target, true) });
        return;
      }
      setPreview({ path: target, kind: 'text', content: (await api.readWorkspaceFile(target)).content });
    } catch (cause) {
      setPreview(undefined);
      setError(cause instanceof ApiError ? cause.message : '无法预览文件，请下载');
    }
  };

  const download = (name: string) => {
    setError('');
    try {
      const link = document.createElement('a');
      link.href = api.workspaceFileContentUrl(childPath(name), false);
      link.rel = 'noopener';
      link.target = '_blank';
      link.click();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '下载失败');
    }
  };

  const remove = async (name: string, type: 'file' | 'dir') => {
    if (!window.confirm(type === 'dir' ? `删除空文件夹 ${name}？` : `删除 ${name}？`)) {
      return;
    }
    setError('');
    try {
      await api.deleteWorkspacePath(childPath(name));
      await load(path);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '删除失败');
    }
  };

  const createFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    setError('');
    try {
      await api.createWorkspaceDirectory(childPath(name));
      setFolderName('');
      setCreating(false);
      await load(path);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '无法创建文件夹');
    }
  };

  return (
    <div
      className={`files-panel${dragOver ? ' drag-over' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        void uploadFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="files-toolbar">
        <div><strong>文件与产物</strong><small>上传的资料和 Agent 产物都在这里</small></div>
        <div className="files-toolbar-actions">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              void uploadFiles(event.target.files ? Array.from(event.target.files) : []);
              event.target.value = '';
            }}
          />
          <button type="button" aria-label="上传文件" title="上传到当前目录" onClick={() => fileInput.current?.click()}>
            <Upload size={14} />
          </button>
          <button type="button" aria-label="新建文件夹" title="新建文件夹" onClick={() => setCreating(true)}>
            <FolderPlus size={14} />
          </button>
          <button type="button" aria-label="刷新" onClick={() => void load(path)}><RefreshCw size={14} /></button>
        </div>
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
      {creating && (
        <form
          className="files-mkdir"
          onSubmit={(event) => {
            event.preventDefault();
            void createFolder();
          }}
        >
          <input
            value={folderName}
            onChange={(event) => setFolderName(event.target.value)}
            placeholder="文件夹名称"
            autoFocus
          />
          <button type="submit">创建</button>
          <button type="button" onClick={() => { setCreating(false); setFolderName(''); }}>取消</button>
        </form>
      )}
      {error && <p className="files-error">{error}</p>}
      <div className="files-list">
        {loading && <p className="files-hint">正在读取文件…</p>}
        {!loading && listing?.entries.length === 0 && (
          <p className="files-hint">这里还没有文件。可以上传资料，或在对话中让 Agent 创建产物。</p>
        )}
        {!loading && listing?.entries.map((entry) => (
          <div key={entry.name} className="file-row-wrap">
            <button
              type="button"
              className="file-row"
              onClick={() => entry.type === 'dir' ? void load(childPath(entry.name)) : void openFile(entry.name)}
            >
              {entry.type === 'dir' ? <Folder size={15} /> : <File size={15} />}
              <span>{entry.name}</span>
              {entry.type === 'file' && entry.size !== undefined && <small>{formatBytes(entry.size)}</small>}
            </button>
            <div className="file-row-actions">
              {entry.type === 'file' && (
                <button type="button" aria-label={`下载 ${entry.name}`} onClick={() => void download(entry.name)}>
                  <Download size={13} />
                </button>
              )}
              <button type="button" aria-label={`删除 ${entry.name}`} onClick={() => void remove(entry.name, entry.type)}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {preview && (
        <section className="file-preview">
          <header>
            <strong>{preview.path.split('/').at(-1)}</strong>
            <span>
              <button type="button" aria-label="下载" onClick={() => void download(preview.path.split('/').at(-1) || preview.path)}>
                <Download size={14} />
              </button>
              <button type="button" aria-label="关闭预览" onClick={() => clearPreview()}><X /></button>
            </span>
          </header>
          {preview.kind === 'image' ? (
            <div className="file-preview-image"><img src={preview.url} alt={preview.path} /></div>
          ) : (
            <pre>{preview.content}</pre>
          )}
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
