import { useEffect, useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';

import './Panel.css';
import './KnowledgePanel.css';

import { AgentApiClient, ApiError } from '../api/client';
import type { KnowledgeHit } from '../api/types';

export function KnowledgePanel({ api }: { api: AgentApiClient }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setHits([]);
    setError('');
    setQuery('');
  }, [api]);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const next = query.trim();
    if (!next) return;
    setLoading(true);
    setError('');
    try {
      setHits(await api.searchKnowledge(next));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '检索失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="workspace-panel knowledge-panel">
      <div className="files-toolbar">
        <div>
          <strong>知识库</strong>
          <small>检索已发布的平台文档和图片</small>
        </div>
      </div>
      <form className="knowledge-form" onSubmit={(event) => void search(event)}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="输入关键词"
        />
        <button type="submit" disabled={loading}>
          <Search size={14} />
          {loading ? '检索中…' : '检索'}
        </button>
      </form>
      {error && <p className="files-error">{error}</p>}
      {!loading && hits.length === 0 && !error && <p className="files-hint">发布文档后即可在此检索。</p>}
      <div className="knowledge-list">
        {hits.map((hit) => (
          <article key={`${hit.documentId}-${hit.excerpt}`} className="knowledge-hit">
            <strong>{hit.title}</strong>
            <p>{hit.excerpt}</p>
            <small>{hit.modality === 'image' ? '图片 · ' : ''}{hit.score.toFixed(2)}</small>
          </article>
        ))}
      </div>
    </div>
  );
}
