import { useEffect, useState, type FormEvent } from 'react';
import { ChevronRight, File, Folder, FolderGit2, GitBranch, RefreshCw } from 'lucide-react';

import { AgentApiClient, ApiError } from '../api/client';
import type { GitStatus, WorkspaceListing } from '../api/types';

export function FilesPanel({ api }: { api: AgentApiClient }) {
  const [path, setPath] = useState('.');
  const [listing, setListing] = useState<WorkspaceListing>();
  const [git, setGit] = useState<GitStatus>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneDirectory, setCloneDirectory] = useState('');
  const [cloning, setCloning] = useState(false);

  const load = async (nextPath = path) => {
    setLoading(true);
    setError('');
    try {
      const [files, status] = await Promise.all([
        api.listWorkspace(nextPath),
        api.gitStatus(nextPath).catch(() => undefined)
      ]);
      setPath(files.path);
      setListing(files);
      setGit(status);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '无法读取工作区');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load('.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const segments = path === '.' ? [] : path.split('/').filter(Boolean);
  const openDir = (name: string) => {
    const next = path === '.' ? name : `${path}/${name}`;
    void load(next);
  };
  const openAncestor = (index: number) => {
    void load(index < 0 ? '.' : segments.slice(0, index + 1).join('/'));
  };

  const clone = async (event: FormEvent) => {
    event.preventDefault();
    if (!cloneUrl.trim()) return;
    setCloning(true);
    setError('');
    try {
      const result = await api.cloneWorkspace({
        url: cloneUrl.trim(),
        ...(cloneDirectory.trim() ? { directory: cloneDirectory.trim() } : {})
      });
      setCloneUrl('');
      setCloneDirectory('');
      await load(result.directory);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '克隆失败');
    } finally {
      setCloning(false);
    }
  };

  return (
    <div className="files-panel">
      <div className="files-toolbar">
        <strong>文件</strong>
        <button type="button" aria-label="刷新" onClick={() => void load(path)}><RefreshCw size={14} /></button>
      </div>
      <div className="files-crumb">
        <button type="button" onClick={() => openAncestor(-1)}>/work</button>
        {segments.map((segment, index) => (
          <span key={`${segment}-${index}`}>
            <ChevronRight size={12} />
            <button type="button" onClick={() => openAncestor(index)}>{segment}</button>
          </span>
        ))}
      </div>
      {git?.repository ? (
        <div className={git.dirty ? 'git-banner dirty' : 'git-banner'}>
          <GitBranch size={14} />
          <span>{git.branch || 'HEAD'}</span>
          <span>{git.dirty ? `${git.files.length} 处未提交` : '工作区干净'}</span>
        </div>
      ) : (
        <p className="files-hint">当前目录不是 Git 仓库。可以克隆远程仓库到 /work/files。</p>
      )}
      {error && <p className="files-error">{error}</p>}
      <div className="files-list">
        {loading && <p className="files-hint">正在读取工作区…</p>}
        {!loading && listing?.entries.length === 0 && <p className="files-hint">这个目录是空的</p>}
        {!loading && listing?.entries.map((entry) => (
          <button
            type="button"
            key={entry.name}
            className="file-row"
            disabled={entry.type !== 'dir'}
            onClick={() => entry.type === 'dir' && openDir(entry.name)}
          >
            {entry.type === 'dir' ? <Folder size={15} /> : <File size={15} />}
            <span>{entry.name}</span>
          </button>
        ))}
      </div>
      {git?.repository && git.files.length > 0 && (
        <div className="git-files">
          {git.files.slice(0, 20).map((item) => (
            <div key={item.path}><code>{item.status}</code><span>{item.path}</span></div>
          ))}
        </div>
      )}
      <form className="clone-form" onSubmit={clone}>
        <label>
          <span>克隆仓库</span>
          <input
            value={cloneUrl}
            onChange={(event) => setCloneUrl(event.target.value)}
            placeholder="https://github.com/org/repo.git"
            required
          />
        </label>
        <label>
          <span>目录（可选）</span>
          <input
            value={cloneDirectory}
            onChange={(event) => setCloneDirectory(event.target.value)}
            placeholder="files/repo"
          />
        </label>
        <button type="submit" disabled={cloning}>
          <FolderGit2 size={14} />
          {cloning ? '克隆中…' : '克隆'}
        </button>
      </form>
    </div>
  );
}
