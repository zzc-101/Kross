import { useEffect, useState } from 'react';
import { FileText, Sparkles } from 'lucide-react';

import { AgentApiClient, ApiError } from '../api/client';
import type { Skill } from '../api/types';

export function SkillsPanel({ api, onApply }: { api: AgentApiClient; onApply(skill: Skill): void }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError('');
    void api.listSkills()
      .then(setSkills)
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : '无法读取技能'))
      .finally(() => setLoading(false));
  }, [api]);

  return (
    <div className="skills-panel">
      <div className="files-toolbar"><div><strong>技能</strong><small>选择一个模板开始工作</small></div></div>
      {error && <p className="files-error">{error}</p>}
      {loading && <p className="files-hint">正在读取技能…</p>}
      <div className="files-list skill-catalog-list">
        {skills.map((skill) => (
          <button key={skill.id} type="button" className="skill-launch-card" onClick={() => onApply(skill)}>
            <span className="skill-launch-icon">{skill.launchMode === 'file' ? <FileText /> : <Sparkles />}</span>
            <span className="skill-launch-copy">
              <strong>{skill.name}</strong>
              {skill.description && <span>{skill.description}</span>}
            </span>
            <span className="skill-launch-action">开始</span>
          </button>
        ))}
        {!loading && skills.length === 0 && <p className="files-hint">当前组织还没有可用技能，请联系组织管理员。</p>}
      </div>
    </div>
  );
}
